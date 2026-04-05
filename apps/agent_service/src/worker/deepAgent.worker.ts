import { Worker } from "bullmq";
import { createDeepAgent } from "deepagents";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Agent, SingleChat } from "@scheduling-agent/database";
import {
  AGENT_CHAT_QUEUE_NAME,
  type AgentChatJobData,
  type AgentChatJobResult,
} from "../queues/agentChat.bull";
import { getRedisConfig } from "../redisClient";
import {
  getLangfuseCallbackHandler,
  flushLangfuse,
} from "../langfuse";
import { createThreadLockRedis, withThreadLock } from "./threadLock";
import { writeConversationMessage } from "../sessionsManagment/conversationMessageWriter";
import { emitAgentReply, emitAgentTyping } from "../socket";
import {
  resolveAgentModel,
  buildAgentSystemPrompt,
  extractReply,
} from "../deepAgent/runDeepAgent";
import { SaveMemoryTool, SearchMemoryTool } from "../tools/memoryTools";
import { ConsultAgentTool } from "../tools/consultAgentTool";
import { ListAgentsTool } from "../tools/listAgentsTool";
import { agentNotesTools } from "../tools/agentNotesTool";
import { workspaceTools } from "../tools/workspaceTools";
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
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const lockRedis = createThreadLockRedis(getRedisConfig());

/**
 * Shared Postgres checkpointer for all deep-agent runs. Keyed by
 * `single_chat_id` (we use it as the LangGraph `thread_id`), so every
 * chat persists its own state across requests.
 */
let _checkpointer: PostgresSaver | null = null;
async function getCheckpointer(): Promise<PostgresSaver> {
  if (_checkpointer) return _checkpointer;
  const url =
    process.env.DATABASE_URL ||
    `postgres://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE}`;
  const saver = PostgresSaver.fromConnString(url);
  await saver.setup();
  _checkpointer = saver;
  return saver;
}

export type DeepAgentWorkerHandle = {
  worker: Worker<AgentChatJobData, AgentChatJobResult, string>;
  close: () => Promise<void>;
};

/**
 * Main chat executor — consumes `agent_chat_jobs` and runs each turn through
 * a `deepagents` deep agent instance built from the target agent's DB config.
 *
 * Flow per job:
 * 1. Resolve the single chat → lock on `single_chat_id` and use it as LangGraph `thread_id`.
 * 2. Persist the user message to `conversation_messages`.
 * 3. Load the agent row + resolve its model (vendor + API key) from the DB.
 * 4. Create a deep agent with `save_memory` / `search_memory` tools and the Postgres checkpointer.
 * 5. Invoke, persist the assistant reply, emit `agent:reply` over Socket.IO.
 */
export function startDeepAgentWorker(): DeepAgentWorkerHandle {
  const worker = new Worker<AgentChatJobData, AgentChatJobResult, string>(
    AGENT_CHAT_QUEUE_NAME,
    async (job) => {
      const { userId, message, singleChatId, agentId, requestId, displayName } =
        job.data;

      if (!singleChatId) {
        throw new Error("deep agent job: singleChatId is required");
      }

      // Resolve the agent for this single chat (the job may carry `agentId`
      // directly, but we trust the single_chats row as the source of truth).
      const sc = await SingleChat.findOne({
        where: { id: singleChatId, userId },
        attributes: ["id", "agentId"],
      });
      if (!sc) {
        throw new Error(
          `deep agent job: single chat ${singleChatId} not found for user ${userId}`,
        );
      }
      const resolvedAgentId = agentId ?? sc.agentId;

      logger.info("DeepAgent: processing chat job", {
        requestId,
        userId,
        singleChatId,
        agentId: resolvedAgentId,
      });

      // Lock per single_chat so concurrent turns in the same chat serialise,
      // but different users chatting with the same agent can run in parallel.
      const lockKey = `single_chat:${singleChatId}`;

      try {
        const result = await withThreadLock(lockRedis, lockKey, async () => {
          emitAgentTyping({
            threadId: singleChatId,
            userId,
            singleChatId,
          });

          // Persist the user turn first so it's durable even if the invoke fails.
          await writeConversationMessage({
            singleChatId,
            role: "user",
            content: message,
            senderName: displayName,
            requestId,
          });

          const agent = await Agent.findByPk(resolvedAgentId);
          if (!agent) {
            throw new Error(`Agent ${resolvedAgentId} not found`);
          }

          const resolved = await resolveAgentModel(agent);

          const tools: StructuredToolInterface[] = [
            SaveMemoryTool(resolvedAgentId, userId),
            SearchMemoryTool(resolvedAgentId, userId),
            ListAgentsTool(resolvedAgentId),
            ConsultAgentTool(resolvedAgentId, userId),
            ...agentNotesTools(resolvedAgentId),
            ...workspaceTools(resolvedAgentId),
          ];

          const checkpointer = await getCheckpointer();
          const deepAgent = createDeepAgent({
            model: resolved.chat as any,
            tools: tools as any[],
            systemPrompt: await buildAgentSystemPrompt(agent, { userId }),
            checkpointer,
          });

          const langfuseHandler = getLangfuseCallbackHandler(userId, {
            threadId: singleChatId,
            requestId,
            agentId: resolvedAgentId,
            service: "deep_agent_chat",
          });
          const tracedAgent = langfuseHandler
            ? deepAgent.withConfig({ callbacks: [langfuseHandler] })
            : deepAgent;

          const invokeResult = await withTimeout(
            tracedAgent.invoke(
              {
                messages: [{ role: "user" as const, content: message }],
              },
              {
                configurable: {
                  // `single_chat_id` IS the LangGraph thread id — 1:1 per chat.
                  thread_id: singleChatId,
                  user_id: String(userId),
                },
                recursionLimit: DEEP_AGENT_RECURSION_LIMIT,
              },
            ),
            DEEP_AGENT_TIMEOUT_MS,
          );

          await flushLangfuse();

          const messages: any[] = Array.isArray(invokeResult.messages)
            ? invokeResult.messages
            : [];
          const reply = extractReply(messages);

          await writeConversationMessage({
            singleChatId,
            role: "assistant",
            content: reply,
            requestId,
            modelSlug: resolved.modelSlug,
            vendorSlug: resolved.vendorSlug,
            modelName: resolved.modelName,
          });

          return {
            threadId: singleChatId,
            reply,
            modelSlug: resolved.modelSlug,
            vendorSlug: resolved.vendorSlug,
            modelName: resolved.modelName,
          };
        });

        logger.info("DeepAgent: chat turn completed", {
          requestId,
          threadId: result.threadId,
          replyLen: result.reply.length,
        });

        emitAgentReply({
          requestId,
          userId,
          threadId: result.threadId,
          singleChatId,
          ok: true,
          reply: result.reply,
          systemPrompt: null,
          modelSlug: result.modelSlug,
          vendorSlug: result.vendorSlug,
          modelName: result.modelName,
        });

        return {
          threadId: result.threadId,
          reply: result.reply,
          systemPrompt: null,
        };
      } catch (err: any) {
        const errorText = err?.message ?? "Deep agent processing failed";

        logger.error("DeepAgent: chat turn failed", {
          requestId,
          singleChatId,
          error: errorText,
        });

        await writeConversationMessage({
          singleChatId,
          role: "assistant",
          content: errorText,
          requestId,
        });
        emitAgentReply({
          requestId,
          userId,
          threadId: singleChatId,
          singleChatId,
          ok: false,
          error: errorText,
        });
        throw err;
      }
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
      requestId: job?.data?.requestId,
      error: err?.message ?? String(err),
    });
  });

  logger.info("DeepAgent worker listening", {
    queue: AGENT_CHAT_QUEUE_NAME,
  });

  return {
    worker,
    close: async () => {
      await worker.close();
      await lockRedis.quit();
    },
  };
}
