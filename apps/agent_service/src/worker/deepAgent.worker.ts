import crypto from "node:crypto";
import { Worker } from "bullmq";
import { createDeepAgent } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import {
  SystemAgent,
  SystemAgentMcpServer,
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
 * Resolves the LangChain model string for createDeepAgent.
 * Returns "provider:model" format (e.g. "openai:gpt-4o", "anthropic:claude-sonnet-4-6").
 */
async function resolveModelString(
  modelSlug: string,
): Promise<string | null> {
  const model = await LLMModel.findOne({
    where: { slug: modelSlug },
    attributes: ["id", "vendorId"],
  });
  if (!model) return null;
  const vendor = await Vendor.findByPk(model.vendorId, {
    attributes: ["slug", "apiKey"],
  });
  if (!vendor?.apiKey) return null;
  // deepagents accepts "provider:model" format
  return `${vendor.slug}:${modelSlug}`;
}

export type DeepAgentWorkerHandle = {
  worker: Worker<DeepAgentJobData>;
  close: () => Promise<void>;
};

/**
 * Deep agent worker — runs specialist agents for complex, long-running tasks
 * using the `deepagents` library (built on LangGraph).
 *
 * Each delegation gets:
 * - A RANDOM thread_id (fresh context per task)
 * - A CONSTANT user_id from system_agents.user_id (persistent memory per agent type)
 *
 * Flow:
 * 1. Load SystemAgent config from DB
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
        systemAgentId,
        systemAgentSlug,
        request,
        callerAgentId,
        userId,
        groupId,
        singleChatId,
      } = job.data;

      logger.info("DeepAgent: processing job", {
        delegationId,
        systemAgentSlug,
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
        // Load system agent config
        const systemAgent = await SystemAgent.findByPk(systemAgentId);
        if (!systemAgent) {
          throw new Error(`System agent ${systemAgentId} not found`);
        }

        // Resolve model for deepagents ("provider:model" format)
        const modelString = await resolveModelString(systemAgent.modelSlug);
        if (!modelString) {
          throw new Error(
            `Cannot resolve model "${systemAgent.modelSlug}" for system agent "${systemAgentSlug}"`,
          );
        }

        // Use the system agent's constant userId for memory scoping.
        // Each delegation gets a fresh thread_id so the deep agent starts clean,
        // but the same userId means its episodic/store memories persist across tasks.
        const deepAgentUserId = systemAgent.userId ?? userId;
        const threadId = crypto.randomUUID();

        // Load MCP tools assigned to this system agent (via junction table)
        const mcpLinks = await SystemAgentMcpServer.findAll({
          where: { systemAgentId: systemAgent.id },
          attributes: ["mcpServerId"],
        });
        const mcpServerIds = mcpLinks.map((l) => l.mcpServerId);
        const mcpTools = mcpServerIds.length > 0
          ? await getMcpToolsByServerIds(mcpServerIds, `system-agent:${systemAgentSlug}`)
          : [];

        const skillTools = systemAgentSkillTools(systemAgent.id);
        const wsTools = workspaceTools(callerAgentId);

        logger.info("DeepAgent: creating agent", {
          delegationId,
          modelString,
          systemAgentUserId: deepAgentUserId,
          threadId,
          mcpToolCount: mcpTools.length,
          skillToolCount: skillTools.length,
          workspaceToolCount: wsTools.length,
        });

        // Create the deep agent with the deepagents library
        const checkpointer = new MemorySaver();
        const agent = createDeepAgent({
          model: modelString,
          tools: [...mcpTools, ...skillTools, ...wsTools] as any[],
          systemPrompt:
            `You are ${systemAgent.name}, a specialist deep agent.\n\n` +
            `${systemAgent.instructions}\n\n` +
            `## Task Guidelines\n` +
            `- Break complex tasks into steps using your todo list\n` +
            `- Be thorough and detailed in your analysis\n` +
            `- Structure your response clearly with sections\n` +
            `- Include all relevant findings and reasoning`,
          checkpointer,
        });

        // Invoke with fresh thread but constant user identity.
        // Wrapped with timeout and recursion limit to prevent runaway executions.
        const langfuseHandler = getLangfuseCallbackHandler(userId, {
          threadId,
          delegationId,
          systemAgentSlug,
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

        const resultText =
          typeof lastAi?.content === "string"
            ? lastAi.content
            : lastAi?.content
              ? JSON.stringify(lastAi.content)
              : "The deep agent did not produce a response.";

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
            `[Deep Agent Result — Delegation ${delegationId}]\n` +
            `System Agent: ${systemAgent.name} (${systemAgentSlug})\n` +
            `Task: ${request.substring(0, 200)}${request.length > 200 ? "..." : ""}\n\n` +
            `## Result\n${resultText}`,
          requestId: `delegation-${delegationId}`,
          groupId: groupId ?? null,
          singleChatId: singleChatId ?? null,
          agentId: callerAgentId,
          mentionsAgent: true,
          displayName: `system:${systemAgentSlug}`,
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
            `The deep agent timed out after ${Math.round(DEEP_AGENT_TIMEOUT_MS / 1000)} seconds. ` +
            `The task may be too complex or the agent got stuck in a loop.`;
        } else if (isRecursionLimit) {
          failureReason =
            `The deep agent reached the maximum number of processing steps (${DEEP_AGENT_RECURSION_LIMIT}). ` +
            `The task may need to be broken into smaller pieces.`;
        } else {
          failureReason = err?.message ?? "Unknown error";
        }

        logger.error("DeepAgent: job failed", {
          delegationId,
          systemAgentSlug,
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
            `[Deep Agent Failed — Delegation ${delegationId}]\n` +
            `System Agent: ${systemAgentSlug}\n` +
            `Task: ${request.substring(0, 200)}${request.length > 200 ? "..." : ""}\n\n` +
            `## Failure\n${failureReason}\n\n` +
            `Please inform the user about this failure and suggest alternatives ` +
            `(e.g. breaking the task into smaller parts, trying a different approach, or retrying later).`,
          requestId: `delegation-${delegationId}`,
          groupId: groupId ?? null,
          singleChatId: singleChatId ?? null,
          agentId: callerAgentId,
          mentionsAgent: true,
          displayName: `system:${systemAgentSlug}`,
        } as any);
      }
        }, // end observeWithContext fn
        { delegationId, systemAgentSlug, callerAgentId, userId },
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
