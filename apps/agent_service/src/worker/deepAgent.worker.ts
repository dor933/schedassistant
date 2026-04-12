import crypto from "node:crypto";
import { Worker } from "bullmq";
import { createDeepAgent } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import {
  Agent,
  AgentAvailableMcpServer,
  DeepAgentDelegation,
  Vendor,
  LLMModel,
} from "@scheduling-agent/database";
import {
  DEEP_AGENT_QUEUE_NAME,
  type DeepAgentJobData,
} from "../queues/deepAgent.bull";
import { agentChatQueue } from "../queues/agentChat.bull";
import { getMcpToolsByServerIds } from "../mcpClient";
import { systemAgentSkillTools } from "../tools/skillsTools";
import { workspaceTools } from "../tools/workspaceTools";
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

/**
 * Resolves a fully configured LangChain chat model instance for createDeepAgent.
 * Uses the same vendor/apiKey/proxy config as regular agents (callModel.ts).
 */
async function resolveModel(modelSlug: string) {
  const model = await LLMModel.findOne({
    where: { slug: modelSlug },
    attributes: ["id", "vendorId"],
  });
  if (!model) return null;
  const vendor = await Vendor.findByPk(model.vendorId, {
    attributes: ["slug", "apiKey"],
  });
  if (!vendor?.apiKey) return null;

  switch (vendor.slug) {
    case "anthropic":
      return new ChatAnthropic({
        modelName: modelSlug,
        temperature: 0.4,
        apiKey: vendor.apiKey,
        ...(process.env.MERIDIAN_URL ? { anthropicApiUrl: process.env.MERIDIAN_URL } : {}),
      });
    case "openai":
      return new ChatOpenAI({ modelName: modelSlug, temperature: 0.4, apiKey: vendor.apiKey });
    case "google":
      return new ChatGoogle({ model: modelSlug, temperature: 0.4, apiKey: vendor.apiKey });
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
        executorAgentSlug,
        request,
        callerAgentId,
        userId,
        groupId,
        singleChatId,
      } = job.data;

      logger.info("DeepAgent: processing job", {
        delegationId,
        executorAgentSlug,
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
        let chatModel = await resolveModel(executorAgent.modelSlug!);
        if (!chatModel) {
          throw new Error(
            `Cannot resolve model "${executorAgent.modelSlug}" for executor agent "${executorAgentSlug}"`,
          );
        }

        // Check if this agent uses Google Search grounding
        const tc = executorAgent.toolConfig as Record<string, unknown> | null;
        const useGoogleSearch = !!tc?.googleSearch;

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
            executorAgentSlug,
            service: "deep_agent",
          });

          const response = await withTimeout(
            googleModel.invoke(
              [
                new SystemMessage(executorAgent.instructions!),
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
            ? await getMcpToolsByServerIds(mcpServerIds, `system-agent:${executorAgentSlug}`)
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
          const wsTools = workspaceTools(callerAgentId);
          const allTools = [...mcpTools, ...skillTools, ...wsTools];

          logger.info("DeepAgent: creating agent", {
            delegationId,
            modelSlug: executorAgent.modelSlug,
            executorAgentUserId: deepAgentUserId,
            threadId,
            toolCount: allTools.length,
          });

          // Create the deep agent with the deepagents library
          const checkpointer = new MemorySaver();
          const agent = createDeepAgent({
            model: chatModel as any,
            tools: allTools as any[],
            systemPrompt:
              `You are ${executorAgent.agentName}, an executor agent — a specialist responsible for carrying out tasks ` +
              `delegated to you by orchestrator agents.\n\n` +
              `${executorAgent.instructions}\n\n` +
              `## Task Guidelines\n` +
              `- Break complex tasks into steps using your todo list\n` +
              `- Be thorough and detailed in your execution\n` +
              `- Use your tools (MCP servers, file operations, etc.) to gather real data and produce real results\n` +
              `- Structure your response clearly with sections\n` +
              `- Include all relevant findings, data, and reasoning\n\n` +
              `## Storage Tiers — read carefully, they are NOT interchangeable\n` +
              `You have access to TWO distinct file storage systems. Using the wrong one will either lose your work ` +
              `or pollute a shared space. Understand the difference before writing anything.\n\n` +
              `### Tier 1 — Ephemeral task scratchpad (\`read_file\` / \`write_file\` / \`edit_file\`)\n` +
              `- A virtual filesystem that exists ONLY for the duration of this single task.\n` +
              `- Everything here is DESTROYED when this task ends. The next time you are invoked, it will be empty.\n` +
              `- Use it for: intermediate notes, draft sections, raw tool output you want to process, working memory ` +
              `that helps you think through THIS task.\n` +
              `- Do NOT put anything here that you (or the orchestrator) will need later. It will be gone.\n\n` +
              `### Tier 2 — Shared persistent workspace (\`workspace_list_files\` / \`workspace_read_file\` / ` +
              `\`workspace_write_file\` / \`workspace_edit_file\` / \`workspace_delete_file\`)\n` +
              `- A real folder on disk that belongs to the orchestrator agent who delegated this task to you.\n` +
              `- Files here PERSIST across tasks and are SHARED with the calling orchestrator. The orchestrator ` +
              `can read what you write, and you can read what the orchestrator (or previous specialists it called) wrote.\n` +
              `- Only \`.md\` and \`.txt\` files are allowed.\n` +
              `- Use it for: durable findings the orchestrator needs to keep, research results worth preserving ` +
              `across future tasks, briefs/plans the orchestrator can refer back to, cross-task context.\n` +
              `- Because this space is shared, treat it like a team drive, not a private scratchpad: use clear, ` +
              `descriptive filenames, do not overwrite files you did not create unless you are deliberately updating them, ` +
              `and never put throwaway drafts here.\n\n` +
              `### Required workflow for every task\n` +
              `1. **Start by orienting:** call \`workspace_list_files\` before doing anything else. If any files look ` +
              `relevant to the current task, read them with \`workspace_read_file\` — they may contain context, prior ` +
              `research, or instructions from the orchestrator that change how you should approach the task.\n` +
              `2. **Do your work:** use Tier 1 (\`write_file\`/\`edit_file\`) freely for scratch and intermediate reasoning.\n` +
              `3. **Finish by persisting what matters:** if your task produced findings, conclusions, or artifacts that ` +
              `the orchestrator or future tasks will benefit from, save them to Tier 2 with \`workspace_write_file\` ` +
              `using a clear filename. Do not save ephemeral scratch here.`,
            checkpointer,
          });

          // Invoke with fresh thread but constant user identity.
          // Wrapped with timeout and recursion limit to prevent runaway executions.
          const langfuseHandler = getLangfuseCallbackHandler(userId, {
            threadId,
            delegationId,
            executorAgentSlug,
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

        // Enqueue delegation_result callback to re-invoke the calling agent
        await agentChatQueue.add("delegation_result", {
          userId,
          message:
            `[Executor Agent Result — Delegation ${delegationId}]\n` +
            `Executor: ${executorAgent.agentName} (${executorAgentSlug})\n` +
            `Task: ${request.substring(0, 200)}${request.length > 200 ? "..." : ""}\n\n` +
            `## Result\n${resultText}`,
          requestId: `delegation-${delegationId}`,
          groupId: groupId ?? null,
          singleChatId: singleChatId ?? null,
          agentId: callerAgentId,
          mentionsAgent: true,
          displayName: `system:${executorAgentSlug}`,
        } as any);

        logger.info("DeepAgent: enqueued delegation_result callback", {
          delegationId,
          callerAgentId,
        });
      } catch (err: any) {
        const isTimeout = err instanceof DeepAgentTimeoutError;
        const isRecursionLimit =
          err?.message?.includes("recursion limit") ||
          err?.message?.includes("Recursion limit");

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
          executorAgentSlug,
          error: failureReason,
          isTimeout,
          isRecursionLimit,
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

        // Enqueue callback so the caller knows about the failure
        await agentChatQueue.add("delegation_result", {
          userId,
          message:
            `[Executor Agent Failed — Delegation ${delegationId}]\n` +
            `Executor: ${executorAgentSlug}\n` +
            `Task: ${request.substring(0, 200)}${request.length > 200 ? "..." : ""}\n\n` +
            `## Failure\n${failureReason}\n\n` +
            `Please inform the user about this failure and suggest alternatives ` +
            `(e.g. breaking the task into smaller parts, trying a different approach, or retrying later).`,
          requestId: `delegation-${delegationId}`,
          groupId: groupId ?? null,
          singleChatId: singleChatId ?? null,
          agentId: callerAgentId,
          mentionsAgent: true,
          displayName: `system:${executorAgentSlug}`,
        } as any);
      }
        }, // end observeWithContext fn
        { delegationId, executorAgentSlug, callerAgentId, userId },
      ); // end observeWithContext
    },
    {
      connection: getRedisConfig(),
      concurrency: Number(process.env.DEEP_AGENT_WORKER_CONCURRENCY ?? "4"),
      lockDuration: Number(
        process.env.DEEP_AGENT_LOCK_DURATION_MS ?? 30 * 60 * 1000, // 30 min default
      ),
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
