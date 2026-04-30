import { createDeepAgent } from "deepagents";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogle } from "@langchain/google";
import { ChatAnthropic } from "@langchain/anthropic";
import { Agent, LLMModel } from "@scheduling-agent/database";

import { resolveOrgVendorByOrg } from "../../../services/resolveOrgVendor.service";
import { anthropicBaseConfig } from "../../../chat/anthropicContextManagement";
import { QueryDatabaseTool } from "../../../tools/queryDatabaseTool";
import { ConsultAgentTool } from "../../../tools/consultAgentTool";
import { ListAgentsTool } from "../../../tools/listAgentsTool";
import { RunClaudeCliTool, RunCodexCliTool } from "../../../tools/runCliTools";
import { KillCliExecutionTool } from "../../../tools/killCliExecutionTool";
import { loadActiveToolSlugs } from "../../../tools/resolveAgentTools";
import { getLangfuseCallbackHandler, flushLangfuse } from "../../../langfuse";
import { logger } from "../../../logger";
import { ApplicationAgentState } from "../state";

/**
 * Singleton PostgresSaver for the inner deep agent. Created on first use
 * and reused across all application invocations so we don't open a new pg
 * pool per request. The outer-graph PostgresSaver (used by basic / epic /
 * roundtable graphs) already calls `setup()` at startup, which is idempotent
 * and creates the shared `checkpoints` / `checkpoint_blobs` / `checkpoint_writes`
 * tables — so this instance does not need its own setup() call.
 */
let _innerCheckpointer: PostgresSaver | null = null;
function getInnerDeepAgentCheckpointer(): PostgresSaver {
  if (_innerCheckpointer) return _innerCheckpointer;
  const connectionString =
    process.env.DATABASE_URL ??
    `postgres://${process.env.PGUSER ?? "scheduler"}:${process.env.PGPASSWORD ?? "scheduler_pass"}@${process.env.PGHOST ?? "localhost"}:${process.env.PGPORT ?? "5432"}/${process.env.PGDATABASE ?? "scheduler_agent"}`;
  _innerCheckpointer = PostgresSaver.fromConnString(connectionString);
  return _innerCheckpointer;
}

/** Default model when the agent row has neither modelId nor modelSlug. */
const DEFAULT_MODEL_SLUG = "gpt-4o";

/** Max time a single application-agent invocation can run before being aborted (ms). */
const APPLICATION_AGENT_TIMEOUT_MS = Number(
  process.env.APPLICATION_AGENT_TIMEOUT_MS ?? 5 * 60 * 1000, // 5 min default
);

/** Max LangGraph node steps inside the deep agent (prevents infinite tool loops). */
const APPLICATION_AGENT_RECURSION_LIMIT = Number(
  process.env.APPLICATION_AGENT_RECURSION_LIMIT ?? 60,
);

class ApplicationAgentTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Application agent execution timed out after ${Math.round(timeoutMs / 1000)} seconds`,
    );
    this.name = "ApplicationAgentTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ApplicationAgentTimeoutError(ms)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Resolves a fully configured LangChain chat model instance for the given
 * application agent. Mirrors deepAgent.worker.resolveModelForAgent — kept
 * inline (rather than shared) so the application graph stays decoupled.
 */
async function resolveModelForApplicationAgent(applicationAgent: Agent) {
  let slug: string | null = null;

  if (applicationAgent.modelId) {
    const byId = await LLMModel.findByPk(applicationAgent.modelId, {
      attributes: ["slug"],
    });
    if (byId) slug = byId.slug;
  }
  if (!slug && applicationAgent.modelSlug) {
    slug = applicationAgent.modelSlug;
  }
  if (!slug) slug = DEFAULT_MODEL_SLUG;

  const vendor = await resolveOrgVendorByOrg(
    slug,
    applicationAgent.organizationId ?? null,
  );
  if (!vendor) {
    logger.warn("ApplicationGraph: model or organization not resolvable", {
      agentId: applicationAgent.id,
      organizationId: applicationAgent.organizationId ?? null,
      modelSlug: slug,
    });
    return null;
  }
  if (!vendor.apiKey) {
    logger.warn("ApplicationGraph: organization has no API key for vendor", {
      agentId: applicationAgent.id,
      organizationId: applicationAgent.organizationId ?? null,
      vendorSlug: vendor.vendorSlug,
    });
    return null;
  }

  switch (vendor.vendorSlug) {
    case "anthropic":
      return new ChatAnthropic({
        modelName: slug,
        apiKey: vendor.apiKey,
        ...(process.env.MERIDIAN_URL ? { anthropicApiUrl: process.env.MERIDIAN_URL } : {}),
        ...anthropicBaseConfig(),
      });
    case "openai":
      return new ChatOpenAI({ modelName: slug, apiKey: vendor.apiKey });
    case "google":
      return new ChatGoogle({ model: slug, apiKey: vendor.apiKey });
    default:
      return null;
  }
}

/**
 * Application-graph call-model node.
 *
 * Builds a fresh deep agent per invocation (MemorySaver checkpointer, ephemeral
 * thread id), wires only the `query_database` tool for v1, runs it with the
 * caller's `request` as the sole user message, and returns the final assistant
 * text on `state.response`.
 */
export async function applicationCallModelNode(
  state: ApplicationAgentState,
): Promise<Partial<ApplicationAgentState>> {
  const { agentId, request, systemPrompt } = state;

  if (state.error) {
    // Context builder rejected — propagate without invoking the model.
    return {};
  }

  if (!request || request.trim().length === 0) {
    return { error: "applicationCallModel: request is empty." };
  }
  // Defensive: the REST controller and primary-tool path both enforce these,
  // but failing loudly here is cheap insurance against future callers.
  if (typeof state.userId !== "number") {
    return { error: "applicationCallModel: userId is required (each invocation must represent a real end user)." };
  }
  if (!state.applicationThreadId) {
    return { error: "applicationCallModel: applicationThreadId is required (resolve via application.service before invoking the graph)." };
  }

  const applicationAgent = await Agent.findByPk(agentId);
  if (!applicationAgent) {
    return { error: `applicationCallModel: agent "${agentId}" not found.` };
  }

  const chatModel = await resolveModelForApplicationAgent(applicationAgent);
  if (!chatModel) {
    return {
      error:
        `Cannot resolve any model for application agent "${agentId}" ` +
        `(modelId=${applicationAgent.modelId}, modelSlug=${applicationAgent.modelSlug}). ` +
        `Verify the agent's model is set and the organization has an API key for that vendor.`,
    };
  }

  // v1 tool set:
  //   - query_database: read-only SQL access (per requirement, always bound).
  //   - list_agents / consult_agent: gated by `agent_available_tools` — application
  //     agents must be granted these explicitly via the admin UI; we deliberately
  //     opt out of the default-tool fallback so a freshly-created application
  //     agent cannot reach primary agents until the admin grants it access.
  // groupId / singleChatId are null because application invocations have no
  // chat scope; the consult-target's reply is returned inline regardless.
  const activeSlugs = await loadActiveToolSlugs(agentId, { applyDefaults: false });
  const has = (slug: string) => activeSlugs.has(slug);

  const tools: any[] = [QueryDatabaseTool()];
  if (has("list_agents")) tools.push(ListAgentsTool(agentId));
  if (has("consult_agent"))
    tools.push(ConsultAgentTool(agentId, state.userId, null, null));
  if (has("run_claude_cli"))
    tools.push(RunClaudeCliTool(agentId, state.userId, state.applicationThreadId));
  if (has("run_codex_cli"))
    tools.push(RunCodexCliTool(agentId, state.userId, state.applicationThreadId));
  if (has("kill_cli_execution"))
    tools.push(KillCliExecutionTool(agentId, state.userId));

  const innerThreadId = state.applicationThreadId;
  const checkpointer = getInnerDeepAgentCheckpointer();

  logger.info("ApplicationGraph: invoking deep agent", {
    agentId,
    userId: state.userId,
    innerThreadId,
    promptLength: systemPrompt.length,
    requestLength: request.length,
    toolCount: tools.length,
  });

  const agent = createDeepAgent({
    model: chatModel as any,
    tools: tools as any[],
    systemPrompt,
    checkpointer,
  });

  // Bake Langfuse callbacks into the agent via withConfig so they propagate
  // to all inner LangGraph nodes (LLM calls, tool calls, etc.). The parent
  // span is opened by `observeWithContext` in application.service; this
  // handler attaches its observations underneath via OTel context propagation.
  // Returns null (and `tracedAgent === agent`) when Langfuse isn't configured.
  const langfuseHandler = getLangfuseCallbackHandler(state.userId ?? undefined, {
    agentId,
    agentName: applicationAgent.agentName,
    innerThreadId,
    service: "application_agent",
  });
  const tracedAgent = langfuseHandler
    ? agent.withConfig({ callbacks: [langfuseHandler] })
    : agent;

  try {
    const result = await withTimeout(
      tracedAgent.invoke(
        {
          messages: [{ role: "user" as const, content: request }],
        },
        {
          configurable: {
            // thread_id selects the PostgresSaver checkpoint to resume —
            // same value across calls = same conversation history rehydrated.
            thread_id: innerThreadId,
            // user_id namespaces the deep agent's built-in memory tools so
            // long-term memory carries across this user's separate threads.
            user_id: String(state.userId),
          },
          recursionLimit: APPLICATION_AGENT_RECURSION_LIMIT,
        },
      ),
      APPLICATION_AGENT_TIMEOUT_MS,
    );

    // Flush traces before returning so observations land even if the outer
    // request handler crashes after this point.
    await flushLangfuse();

    const messages: any[] = Array.isArray(result.messages) ? result.messages : [];
    const lastAi = [...messages]
      .reverse()
      .find(
        (m: any) =>
          (typeof m._getType === "function" && m._getType() === "ai") ||
          m.role === "assistant",
      );

    const response =
      typeof lastAi?.content === "string"
        ? lastAi.content
        : lastAi?.content
          ? JSON.stringify(lastAi.content)
          : "The application agent did not produce a response.";

    logger.info("ApplicationGraph: invocation completed", {
      agentId,
      innerThreadId,
      responseLength: response.length,
    });

    return { response };
  } catch (err: any) {
    const isTimeout = err instanceof ApplicationAgentTimeoutError;
    const isRecursionLimit =
      err?.message?.includes("recursion limit") ||
      err?.message?.includes("Recursion limit");

    let failureReason: string;
    if (isTimeout) {
      failureReason =
        `The application agent timed out after ` +
        `${Math.round(APPLICATION_AGENT_TIMEOUT_MS / 1000)} seconds.`;
    } else if (isRecursionLimit) {
      failureReason =
        `The application agent reached the maximum number of processing steps ` +
        `(${APPLICATION_AGENT_RECURSION_LIMIT}).`;
    } else {
      failureReason = err?.message ?? "Unknown error";
    }

    logger.error("ApplicationGraph: invocation failed", {
      agentId,
      innerThreadId,
      error: failureReason,
      isTimeout,
      isRecursionLimit,
    });

    return { error: failureReason };
  }
}
