import { Worker } from "bullmq";
import type { CompiledStateGraph } from "@langchain/langgraph";

import {
  AGENT_CHAT_QUEUE_NAME,
  type AgentChatJobData,
  type AgentChatJobResult,
} from "../queues/agentChat.bull";
import { getRedisConfig } from "../redisClient";
import { executeChatTurn, storeMessageOnly } from "../chat/executeChatTurn";
import { createThreadLockRedis, withThreadLock } from "./threadLock";
import { emitAgentReply, emitAgentTyping } from "../socket";
import { logger } from "../logger";

const redisConfig = getRedisConfig();
const lockRedis = createThreadLockRedis(redisConfig);

export type AgentChatWorkerHandle = {
  worker: Worker<AgentChatJobData, AgentChatJobResult, string>;
  close: () => Promise<void>;
};

/**
 * Starts a BullMQ worker that processes `agent_chat_jobs`.
 * Each job acquires a Redis lock keyed by `threadId` before calling `graph.invoke`, so
 * two jobs for the same thread never run concurrently (later jobs wait on the lock).
 * When done, emits the result via Socket.IO to user_app.
 */
export function startAgentChatWorker(
  graph: CompiledStateGraph<any, any, any>,
): AgentChatWorkerHandle {
  const worker = new Worker<AgentChatJobData, AgentChatJobResult, string>(
    AGENT_CHAT_QUEUE_NAME,
    async (job) => {
      const { userId, threadId, message, groupId, singleChatId, agentId, requestId, mentionsAgent, displayName } =
        job.data;

      logger.info("Processing chat job", { requestId, userId, threadId, groupId, singleChatId, mentionsAgent });

      // Group message without @mention → store only, no agent invocation
      if (groupId && mentionsAgent === false) {
        try {
          await withThreadLock(lockRedis, threadId, () =>
            storeMessageOnly(graph, { userId, threadId, message, groupId, singleChatId, agentId, displayName }),
          );
          return { threadId, reply: "", systemPrompt: null };
        } catch (err: any) {
          logger.error("Store-only failed", { requestId, threadId, error: err?.message });
          throw err;
        }
      }

      emitAgentTyping({
        threadId,
        userId,
        groupId: groupId ?? null,
        singleChatId: singleChatId ?? null,
      });

      try {
        const result = await withThreadLock(lockRedis, threadId, () =>
          executeChatTurn(graph, {
            userId,
            threadId,
            message,
            groupId,
            singleChatId,
            agentId,
            displayName,
          }),
        );

        logger.info("Chat turn completed", { requestId, threadId, replyLen: result.reply.length });

        emitAgentReply({
          requestId,
          userId,
          threadId,
          groupId: groupId ?? null,
          singleChatId: singleChatId ?? null,
          ok: true,
          reply: result.reply,
          systemPrompt: result.systemPrompt,
          ...(result.modelSlug ? { modelSlug: result.modelSlug } : {}),
          ...(result.vendorSlug ? { vendorSlug: result.vendorSlug } : {}),
          ...(result.modelName ? { modelName: result.modelName } : {}),
        });

        return result;
      } catch (err: any) {
        logger.error("Chat turn failed", { requestId, threadId, error: err?.message });

        emitAgentReply({
          requestId,
          userId,
          threadId,
          groupId: groupId ?? null,
          singleChatId: singleChatId ?? null,
          ok: false,
          error: err?.message ?? "Agent processing failed",
        });
        throw err;
      }
    },
    {
      connection: redisConfig,
      concurrency: Number(process.env.AGENT_CHAT_WORKER_CONCURRENCY ?? "32"),
      lockDuration: Number(
        process.env.AGENT_CHAT_LOCK_DURATION_MS ?? 10 * 60 * 1000,
      ),
    },
  );

  worker.on("failed", (job, err) => {
    logger.error("BullMQ job failed", {
      bullJobId: job?.id,
      threadId: job?.data?.threadId,
      error: err?.message ?? String(err),
    });
  });

  worker.on("stalled", (jobId) => {
    logger.warn("BullMQ job stalled", { bullJobId: jobId });
  });

  logger.info("Worker listening", {
    queue: AGENT_CHAT_QUEUE_NAME,
    concurrency: Number(process.env.AGENT_CHAT_WORKER_CONCURRENCY ?? "32"),
  });

  return {
    worker,
    close: async () => {
      await worker.close();
      await lockRedis.quit();
    },
  };
}
