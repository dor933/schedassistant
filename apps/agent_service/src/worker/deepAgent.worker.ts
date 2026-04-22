import crypto from "node:crypto";
import { Worker } from "bullmq";
import { createDeepAgent } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import {
  Agent,
  AgentAvailableMcpServer,
  DeepAgentDelegation,
  LLMModel,
} from "@scheduling-agent/database";
import { resolveOrgVendorByOrg } from "../services/resolveOrgVendor";
import { loadOrganizationSummarySection } from "../graphs/basicGraph/nodes/contextBuilder";
import {
  DEEP_AGENT_QUEUE_NAME,
  type DeepAgentJobData,
} from "../queues/deepAgent.bull";
import { agentChatQueue } from "../queues/agentChat.bull";
import { getMcpToolsByServerIds } from "../mcpClient";
import { systemAgentSkillTools } from "../tools/skillsTools";
import { hasFilesystemMcp } from "../tools/hasFilesystemMcp";
import { getLibraryPath } from "../services/library.service";
import { loadActiveToolSlugs } from "../tools/resolveAgentTools";
import { QueryDatabaseTool } from "../tools/queryDatabaseTool";
import { ConsultAgentTool } from "../tools/consultAgentTool";
import { googleTools } from "../tools/googleTools";
import { ListSystemAgentsTool } from "../tools/listSystemAgentsTool";
import { ListAgentsTool } from "../tools/listAgentsTool";
import { TavilySearchTool } from "../tools/tavilySearchTool";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogle } from "@langchain/google";
import { ChatAnthropic } from "@langchain/anthropic";
import { getRedisConfig } from "../redisClient";
import { getLangfuseCallbackHandler, observeWithContext, flushLangfuse } from "../langfuse";
import { logger } from "../logger";

/** Max time a deep agent invocation can run before being aborted (ms). */
const DEEP_AGENT_TIMEOUT_MS = Number(
  process.env.DEEP_AGENT_TIMEOUT_MS ?? 15 * 60 * 1000, // 15 min default
);

/** Max LangGraph node steps (prevents infinite tool loops). */
const DEEP_AGENT_RECURSION_LIMIT = Number(
  process.env.DEEP_AGENT_RECURSION_LIMIT ?? 80,
);

/** Max retries for transient failures (rate limits, network errors). */
const DEEP_AGENT_MAX_RETRIES = Number(
  process.env.DEEP_AGENT_MAX_RETRIES ?? 2,
);

/** Max characters for a deep agent result injected into caller context. */
const MAX_RESULT_CHARS = Number(
  process.env.DEEP_AGENT_MAX_RESULT_CHARS ?? 15_000,
);

/**
 * Determines if an error is transient and worth retrying (rate limits, network).
 */
function isTransientError(err: unknown): boolean {
  if (err instanceof DeepAgentTimeoutError) return false; // timeouts are not retried
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /rate.?limit/i.test(msg) ||
    /429/i.test(msg) ||
    /503/i.test(msg) ||
    /ECONNREFUSED/i.test(msg) ||
    /ETIMEDOUT/i.test(msg) ||
    /ECONNRESET/i.test(msg) ||
    /overloaded/i.test(msg)
  );
}

/**
 * Truncates a deep agent result if it exceeds MAX_RESULT_CHARS so the caller
 * agent's context window isn't blown by a single delegation result.
 */
function truncateResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const truncated = text.slice(0, MAX_RESULT_CHARS);
  return (
    truncated +
    `\n\n[RESULT TRUNCATED — original was ${text.length.toLocaleString()} chars, showing first ${MAX_RESULT_CHARS.toLocaleString()}. ` +
    `If you need the full result, ask the user to re-run with a narrower scope.]`
  );
}

class DeepAgentTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Deep agent execution timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    this.name = "DeepAgentTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeepAgentTimeoutError(ms)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

const DEFAULT_MODEL_SLUG = "gpt-4o";

/**
 * Resolves a fully configured LangChain chat model instance for createDeepAgent.
 *
 * Resolution order (mirrors the rest of the codebase):
 *  1. agent.modelId  → lookup LLMModel by PK
 *  2. agent.modelSlug → lookup LLMModel by slug
 *  3. DEFAULT_MODEL_SLUG ("gpt-4o") fallback
 */
async function resolveModelForAgent(executorAgent: Agent) {
  // Pick the model slug first, respecting the same resolution order as before,
  // then hand off to resolveOrgVendorByOrg to look up the API key scoped to the
  // executor agent's organization. The executor's org — not the caller's —
  // owns the keys because the executor is the one making the billable call.
  let slug: string | null = null;

  if (executorAgent.modelId) {
    const byId = await LLMModel.findByPk(executorAgent.modelId, { attributes: ["slug"] });
    if (byId) slug = byId.slug;
  }
  if (!slug && executorAgent.modelSlug) {
    slug = executorAgent.modelSlug;
  }
  if (!slug) slug = DEFAULT_MODEL_SLUG;

  const vendor = await resolveOrgVendorByOrg(slug, executorAgent.organizationId ?? null);
  if (!vendor) {
    logger.warn("DeepAgent: model or organization not resolvable", {
      agentId: executorAgent.id,
      organizationId: executorAgent.organizationId ?? null,
      modelSlug: slug,
    });
    return null;
  }
  if (!vendor.apiKey) {
    logger.warn("DeepAgent: organization has no API key for vendor", {
      agentId: executorAgent.id,
      organizationId: executorAgent.organizationId ?? null,
      vendorSlug: vendor.vendorSlug,
    });
    return null;
  }

  logger.info("DeepAgent: model resolved", {
    agentId: executorAgent.id,
    resolvedSlug: slug,
    vendorSlug: vendor.vendorSlug,
  });

  switch (vendor.vendorSlug) {
    case "anthropic":
      return new ChatAnthropic({
        modelName: slug,
        temperature: 0.4,
        apiKey: vendor.apiKey,
        ...(process.env.MERIDIAN_URL ? { anthropicApiUrl: process.env.MERIDIAN_URL } : {}),
      });
    case "openai":
      return new ChatOpenAI({ modelName: slug, temperature: 0.4, apiKey: vendor.apiKey });
    case "google":
      return new ChatGoogle({ model: slug, temperature: 0.4, apiKey: vendor.apiKey });
    default:
      return null;
  }
}

export type DeepAgentWorkerHandle = {
  worker: Worker<DeepAgentJobData>;
  close: () => Promise<void>;
};

/**
 * Executor agent worker — runs specialist agents for tasks delegated by orchestrators,
 * using the `deepagents` library (built on LangGraph).
 *
 * Each delegation gets:
 * - A RANDOM thread_id (fresh context per task)
 * - A CONSTANT user_id from agents.user_id (persistent memory per agent type)
 *
 * Flow:
 * 1. Load executor agent config from DB
 * 2. Create a deep agent via createDeepAgent() with the system agent's instructions/model
 * 3. Invoke with the delegation request
 * 4. Update delegation record with result
 * 5. Enqueue delegation_result callback to re-invoke the calling agent
 */
export function startDeepAgentWorker(): DeepAgentWorkerHandle {
  const worker = new Worker<DeepAgentJobData>(
    DEEP_AGENT_QUEUE_NAME,
    async (job) => {
      const {
        delegationId,
        executorAgentId,
        request,
        callerAgentId,
        userId,
        groupId,
        singleChatId,
      } = job.data;

      logger.info("DeepAgent: processing job", {
        delegationId,
        executorAgentId,
        callerAgentId,
        requestLen: request.length,
      });

      // Mark as running
      await DeepAgentDelegation.update(
        { status: "running" },
        { where: { id: delegationId } },
      );

      await observeWithContext(
        "deep_agent_run",
        async () => {
      try {
        // Load executor agent config
        const executorAgent = await Agent.findByPk(executorAgentId);
        if (!executorAgent) {
          throw new Error(`Executor agent ${executorAgentId} not found`);
        }

        // Resolve a fully configured LangChain model instance (with API key + proxy)
        let chatModel = await resolveModelForAgent(executorAgent);
        if (!chatModel) {
          throw new Error(
            `Cannot resolve any model for executor agent "${executorAgentId}" ` +
            `(modelId=${executorAgent.modelId}, modelSlug=${executorAgent.modelSlug})`,
          );
        }

        // Check if this agent uses Google Search grounding, Tavily search,
        // or Google Workspace (Gmail / Calendar / Drive) tools. The Google
        // Workspace tools are bound ONLY to the dedicated
        // `google_workspace_agent` system agent
        // (toolConfig.useGoogleWorkspaceTools). Durable workspace/library
        // reads and writes ride on the filesystem MCP when the executor has
        // it attached — no dedicated workspace tools are injected here.
        const tc = executorAgent.toolConfig as Record<string, unknown> | null;
        const useGoogleSearch = !!tc?.googleSearch;
        const useTavily = !!tc?.useTavily;
        const useGoogleWorkspaceTools = !!tc?.useGoogleWorkspaceTools;

        // Organization-wide grounding prepended to every executor's prompt.
        const orgSummarySection = await loadOrganizationSummarySection(
          executorAgent.organizationId ?? null,
        );
        const orgSummaryBlock = orgSummarySection.trim().length > 0
          ? `${orgSummarySection.trim()}\n\n`
          : "";

        // Use the executor agent's constant userId for memory scoping.
        const deepAgentUserId = executorAgent.userId ?? userId;
        const threadId = crypto.randomUUID();

        let resultText: string;

        if (useGoogleSearch) {
          // ── Google Search agent: invoke the model directly with grounding ──
          // We skip createDeepAgent entirely because it binds its own built-in
          // tools to the model, which conflicts with ChatGoogle's googleSearch.
          const googleModel = (chatModel as ChatGoogle).bindTools([{ googleSearch: {} }]);

          logger.info("DeepAgent: invoking Google Search agent directly", {
            delegationId,
            modelSlug: executorAgent.modelSlug,
            threadId,
          });

          const langfuseHandler = getLangfuseCallbackHandler(userId, {
            threadId,
            delegationId,
            executorAgentId,
            service: "deep_agent",
          });

          const response = await withTimeout(
            googleModel.invoke(
              [
                new SystemMessage(`${orgSummaryBlock}${executorAgent.instructions!}`),
                new HumanMessage(request),
              ],
              langfuseHandler ? { callbacks: [langfuseHandler] } : undefined,
            ),
            DEEP_AGENT_TIMEOUT_MS,
          );

          await flushLangfuse();

          resultText =
            typeof response.content === "string"
              ? response.content
              : response.content
                ? JSON.stringify(response.content)
                : "The web search agent did not produce a response.";
        } else {
          // ── Standard deep agent path ──
          // Load active MCP tools available to this executor agent
          const mcpLinks = await AgentAvailableMcpServer.findAll({
            where: { agentId: executorAgent.id, active: true },
            attributes: ["mcpServerId"],
          });
          const mcpServerIds = mcpLinks.map((l) => l.mcpServerId);
          const rawMcpTools = mcpServerIds.length > 0
            ? await getMcpToolsByServerIds(mcpServerIds, `system-agent:${executorAgentId}`)
            : [];

          // deepagents has built-in tools: read_file, write_file, edit_file.
          // MCP servers (especially filesystem) may expose tools with the same names.
          // Filter out collisions — the agent uses deepagents' built-ins for its
          // virtual workspace, and the remaining MCP tools for everything else.
          const DEEP_AGENT_BUILTIN_NAMES = new Set(["read_file", "write_file", "edit_file"]);
          const mcpTools = rawMcpTools.filter((t: any) => {
            if (DEEP_AGENT_BUILTIN_NAMES.has(t.name)) {
              logger.warn("DeepAgent: skipping MCP tool that conflicts with built-in", {
                tool: t.name,
                delegationId,
              });
              return false;
            }
            return true;
          });

          const skillTools = systemAgentSkillTools(executorAgent.id);

          // Does the executor have the filesystem MCP attached? Drives
          // whether we include the durable workspace / library guidance in
          // the prompt — with no filesystem MCP the executor has no way to
          // read or write the caller's workspace, so there is nothing
          // meaningful to tell it about those paths.
          const executorHasFilesystemMcp = mcpServerIds.length > 0
            ? await hasFilesystemMcp(executorAgent.id)
            : false;

          // Caller's persistent workspace directory — the executor, when it
          // has filesystem MCP access, writes durable artifacts there so the
          // calling orchestrator can pick them up. System executor agents
          // have no workspace of their own (workspace_path is NULL per
          // migration 20240101000084); they always act on the caller's
          // directory. If the caller has none, we fall back to no section.
          let callerWorkspacePath: string | null = null;
          if (executorHasFilesystemMcp && callerAgentId) {
            const callerAgent = await Agent.findByPk(callerAgentId, {
              attributes: ["id", "workspacePath"],
            });
            callerWorkspacePath = callerAgent?.workspacePath ?? null;
          }

          // Load configurable tools gated by agent_available_tools (same as callModel)
          const activeSlugs = await loadActiveToolSlugs(executorAgent.id);
          const has = (slug: string) => activeSlugs.has(slug);
          const configurableTools: any[] = [];
          if (has("query_database")) configurableTools.push(QueryDatabaseTool());
          if (has("consult_agent"))
            configurableTools.push(ConsultAgentTool(executorAgent.id, userId, groupId ?? null, singleChatId ?? null));
          if (has("list_agents")) configurableTools.push(ListAgentsTool(executorAgent.id));
          if (has("list_system_agents")) configurableTools.push(ListSystemAgentsTool(executorAgent.id));

          // Google Workspace (Gmail / Calendar / Drive) tools — bound ONLY to
          // the dedicated `google_workspace_agent` system agent
          // (tool_config.useGoogleWorkspaceTools). Executor/system agents do
          // NOT own scope grants themselves; they inherit from the caller, so
          // we key the permission check to callerAgentId. If the caller lacks
          // the grant, the tool returns a deny message at invocation time.
          const googleAgentTools = useGoogleWorkspaceTools ? googleTools(callerAgentId) : [];

          // Tavily web-search tool — injected for the dedicated Tavily-backed
          // web-search system agent (toolConfig.useTavily=true). Tavily is a
          // LangChain-native tool so, unlike Brave, it does NOT come in via
          // MCP; we just add it to the tools array directly.
          const tavilyTools = useTavily ? [TavilySearchTool()] : [];

          const allTools = [
            ...mcpTools,
            ...skillTools,
            ...configurableTools,
            ...googleAgentTools,
            ...tavilyTools,
          ];

          logger.info("DeepAgent: creating agent", {
            delegationId,
            modelSlug: executorAgent.modelSlug,
            executorAgentUserId: deepAgentUserId,
            threadId,
            toolCount: allTools.length,
          });

          // Workspace + library guidance — only emitted when this executor
          // has the filesystem MCP attached and the caller actually has a
          // workspace directory. Without filesystem MCP the executor has no
          // tools to honour this guidance; without a caller workspace there
          // is nowhere for it to write.
          const libraryPath = getLibraryPath();
          const workspaceSection = executorHasFilesystemMcp && callerWorkspacePath
            ? (
                `## Caller workspace + org library (filesystem MCP)\n` +
                `You have the filesystem MCP attached, rooted at \`/app/data\`. Use its tools ` +
                `(\`read_text_file\`, \`write_file\`, \`edit_file\`, \`list_directory\`, \`search_files\`, ` +
                `\`create_directory\`, \`move_file\`) for all durable reads and writes.\n\n` +
                `- **CALLER_WORKSPACE_PATH = \`${callerWorkspacePath}\`** — the orchestrator that delegated to you ` +
                `owns this directory. You do not have a workspace of your own. Write any durable artifacts (plans, ` +
                `findings, briefs) here so the orchestrator can read them. **Orient first**: \`list_directory\` on ` +
                `this path before you start, and \`read_text_file\` anything that looks relevant to your task — the ` +
                `orchestrator or prior specialists may have left context.\n` +
                `- **LIBRARY_PATH = \`${libraryPath}\`** — read-only org-wide reference documents curated by admins. ` +
                `Consult before answering questions about internal policies, terminology, or procedures. Never write ` +
                `or delete anything under this path.\n\n` +
                `### Required: self-report workspace writes\n` +
                `At the very end of your final response to the orchestrator, include a top-level section titled ` +
                `exactly \`## Workspace writes\` listing every file you created, edited, moved, or deleted under ` +
                `\`CALLER_WORKSPACE_PATH\`. One bullet per file (path relative to that directory) with a one-line ` +
                `summary of what it contains or why you changed it. If you made no workspace changes, include the ` +
                `section with a single bullet \`- (none)\`. The orchestrator relies on this to know what changed.\n\n`
              )
            : executorHasFilesystemMcp
              ? (
                  `## Org library (filesystem MCP)\n` +
                  `You have the filesystem MCP attached. The admin-curated org library lives at ` +
                  `\`${libraryPath}\` — read-only. Use \`list_directory\` / \`read_text_file\` to consult it when a ` +
                  `question touches org-specific policies or terminology. No caller workspace was provided for this ` +
                  `delegation, so there is no directory to write durable artifacts into — return findings inline.\n\n`
                )
              : "";

          // Create the deep agent with the deepagents library
          const checkpointer = new MemorySaver();
          const agent = createDeepAgent({
            model: chatModel as any,
            tools: allTools as any[],
            systemPrompt:
              `${orgSummaryBlock}` +
              `You are ${executorAgent.agentName}, an executor agent — a specialist responsible for carrying out tasks ` +
              `delegated to you by orchestrator agents.\n\n` +
              `${executorAgent.instructions}\n\n` +
              `## Task Guidelines\n` +
              `- Break complex tasks into steps using your todo list\n` +
              `- Be thorough and detailed in your execution\n` +
              `- Use your tools (MCP servers, file operations, etc.) to gather real data and produce real results\n` +
              `- Structure your response clearly with sections\n` +
              `- Include all relevant findings, data, and reasoning\n\n` +
              `${workspaceSection}` +
              `## Ephemeral scratchpad\n` +
              `\`read_file\` / \`write_file\` / \`edit_file\` (no path prefix) target a virtual in-memory filesystem ` +
              `scoped to this single task — it vanishes when the task ends. Use it for intermediate notes and raw ` +
              `tool output you want to process. Do NOT put anything here that you or the orchestrator will need ` +
              `later.`,
            checkpointer,
          });

          // Invoke with fresh thread but constant user identity.
          // Wrapped with timeout and recursion limit to prevent runaway executions.
          const langfuseHandler = getLangfuseCallbackHandler(userId, {
            threadId,
            delegationId,
            executorAgentId,
            service: "deep_agent",
          });

          // Bake Langfuse callbacks into the agent via withConfig so they
          // propagate to all inner LangGraph nodes (LLM calls, tool calls, etc.).
          const tracedAgent = langfuseHandler
            ? agent.withConfig({ callbacks: [langfuseHandler] })
            : agent;

          const result = await withTimeout(
            tracedAgent.invoke(
              {
                messages: [{ role: "user" as const, content: request }],
              },
              {
                configurable: {
                  thread_id: threadId,
                  user_id: String(deepAgentUserId),
                },
                recursionLimit: DEEP_AGENT_RECURSION_LIMIT,
              },
            ),
            DEEP_AGENT_TIMEOUT_MS,
          );

          // Flush traces before extracting result (safety net if worker crashes later)
          await flushLangfuse();

          // Extract the final response
          const messages: any[] = Array.isArray(result.messages)
            ? result.messages
            : [];
          const lastAi = [...messages]
            .reverse()
            .find(
              (m: any) =>
                (typeof m._getType === "function" && m._getType() === "ai") ||
                m.role === "assistant",
            );

          resultText =
            typeof lastAi?.content === "string"
              ? lastAi.content
              : lastAi?.content
                ? JSON.stringify(lastAi.content)
                : "The executor agent did not produce a response.";
        }

        // Mark as completed
        await DeepAgentDelegation.update(
          {
            status: "completed",
            result: resultText,
            completedAt: new Date(),
          },
          { where: { id: delegationId } },
        );

        logger.info("DeepAgent: completed", {
          delegationId,
          resultLen: resultText.length,
          threadId,
        });

        // In syncMode the caller is blocking via waitUntilFinished — skip the callback.
        // Note: when the executor has filesystem MCP + a caller workspace, its
        // own final message already includes a `## Workspace writes` section
        // per the system prompt, so the caller sees what changed without a
        // server-side recorder.
        if (!job.data.syncMode) {
          const label = executorAgent.agentName || executorAgent.definition || executorAgentId;
          const callbackResult = truncateResult(resultText);
          await agentChatQueue.add("delegation_result", {
            userId,
            message:
              `[Executor Agent Result — Delegation ${delegationId}]\n` +
              `Executor: ${label} (${executorAgentId})\n` +
              `Task: ${request.substring(0, 200)}${request.length > 200 ? "..." : ""}\n\n` +
              `## Result\n${callbackResult}`,
            requestId: `delegation-${delegationId}`,
            groupId: groupId ?? null,
            singleChatId: singleChatId ?? null,
            agentId: callerAgentId,
            mentionsAgent: true,
            displayName: `system:${executorAgentId}`,
          } as any);

          logger.info("DeepAgent: enqueued delegation_result callback", {
            delegationId,
            callerAgentId,
          });
        }

        return resultText;
      } catch (err: any) {
        const isTimeout = err instanceof DeepAgentTimeoutError;
        const isRecursionLimit =
          err?.message?.includes("recursion limit") ||
          err?.message?.includes("Recursion limit");

        // Retry transient errors (rate limits, network) with exponential backoff
        const attemptsMade = (job.attemptsMade ?? 0) + 1;
        if (isTransientError(err) && attemptsMade <= DEEP_AGENT_MAX_RETRIES) {
          const backoffMs = Math.min(1000 * Math.pow(2, attemptsMade), 30_000);
          logger.warn("DeepAgent: transient error, will retry", {
            delegationId,
            executorAgentId,
            attempt: attemptsMade,
            maxRetries: DEEP_AGENT_MAX_RETRIES,
            backoffMs,
            error: err?.message,
          });
          // Re-throw to let BullMQ handle the retry with configured backoff
          throw err;
        }

        let failureReason: string;
        if (isTimeout) {
          failureReason =
            `The executor agent timed out after ${Math.round(DEEP_AGENT_TIMEOUT_MS / 1000)} seconds. ` +
            `The task may be too complex or the agent got stuck in a loop.`;
        } else if (isRecursionLimit) {
          failureReason =
            `The executor agent reached the maximum number of processing steps (${DEEP_AGENT_RECURSION_LIMIT}). ` +
            `The task may need to be broken into smaller pieces.`;
        } else {
          failureReason = err?.message ?? "Unknown error";
        }

        logger.error("DeepAgent: job failed", {
          delegationId,
          executorAgentId,
          error: failureReason,
          isTimeout,
          isRecursionLimit,
          attempt: attemptsMade,
        });

        // Mark as failed
        await DeepAgentDelegation.update(
          {
            status: "failed",
            error: failureReason,
            completedAt: new Date(),
          },
          { where: { id: delegationId } },
        );

        if (!job.data.syncMode) {
          await agentChatQueue.add("delegation_result", {
            userId,
            message:
              `[Executor Agent Failed — Delegation ${delegationId}]\n` +
              `Executor: ${executorAgentId}\n` +
              `Task: ${request.substring(0, 200)}${request.length > 200 ? "..." : ""}\n\n` +
              `## Failure\n${failureReason}\n\n` +
              `Please inform the user about this failure and suggest alternatives ` +
              `(e.g. breaking the task into smaller parts, trying a different approach, or retrying later).`,
            requestId: `delegation-${delegationId}`,
            groupId: groupId ?? null,
            singleChatId: singleChatId ?? null,
            agentId: callerAgentId,
            mentionsAgent: true,
            displayName: `system:${executorAgentId}`,
          } as any);
        }

        // Re-throw so syncMode callers (waitUntilFinished) see the failure.
        throw new Error(failureReason);
      }
        }, // end observeWithContext fn
        { delegationId, executorAgentId, callerAgentId, userId },
      ); // end observeWithContext
    },
    {
      connection: getRedisConfig(),
      concurrency: Number(process.env.DEEP_AGENT_WORKER_CONCURRENCY ?? "4"),
      lockDuration: Number(
        process.env.DEEP_AGENT_LOCK_DURATION_MS ?? 30 * 60 * 1000, // 30 min default
      ),
      settings: {
        backoffStrategy: (attemptsMade: number) => {
          // Exponential backoff: 2s, 4s, 8s, ... capped at 30s
          return Math.min(1000 * Math.pow(2, attemptsMade), 30_000);
        },
      },
    },
  );

  worker.on("failed", (job, err) => {
    logger.error("DeepAgent BullMQ job failed", {
      bullJobId: job?.id,
      delegationId: job?.data?.delegationId,
      error: err?.message ?? String(err),
    });
  });

  logger.info("DeepAgent worker listening", {
    queue: DEEP_AGENT_QUEUE_NAME,
    concurrency: Number(process.env.DEEP_AGENT_WORKER_CONCURRENCY ?? "4"),
  });

  return {
    worker,
    close: () => worker.close(),
  };
}
