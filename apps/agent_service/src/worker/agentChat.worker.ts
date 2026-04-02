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
import { ensureCanonicalThreadId } from "../sessionsManagment/canonicalThread";
import { writeConversationMessage } from "../sessionsManagment/conversationMessageWriter";
import { Group, SingleChat } from "@scheduling-agent/database";
import { logger } from "../logger";

const redisConfig = getRedisConfig();
const lockRedis = createThreadLockRedis(redisConfig);

export type AgentChatWorkerHandle = {
  worker: Worker<AgentChatJobData, AgentChatJobResult, string>;
  close: () => Promise<void>;
};

/**
 * Starts a BullMQ worker that processes `agent_chat_jobs`.
 * Each job acquires a Redis lock per **agent** before
 * `ensureCanonicalThreadId` and `graph.invoke`, so the same LangGraph
 * thread (shared by all conversations for an agent) never runs twice at once.
 * When done, emits the result via Socket.IO to user_app.
 */
export function startAgentChatWorker(
  graph: CompiledStateGraph<any, any, any>,
): AgentChatWorkerHandle {
  const worker = new Worker<AgentChatJobData, AgentChatJobResult, string>(
    AGENT_CHAT_QUEUE_NAME,
    async (job) => {
      const {
        userId,
        message,
        groupId,
        singleChatId,
        agentId,
        requestId,
        mentionsAgent,
        displayName,
      } = job.data;

      // Resolve agentId for lock scoping — all conversations sharing
      // an agent must serialise on the same lock to avoid concurrent
      // graph.invoke on the same LangGraph thread.
      let resolvedAgentId = agentId ?? null;
      if (!resolvedAgentId && groupId) {
        const g = await Group.findByPk(groupId, { attributes: ["agentId"] });
        resolvedAgentId = g?.agentId ?? null;
      }
      if (!resolvedAgentId && singleChatId) {
        const sc = await SingleChat.findByPk(singleChatId, { attributes: ["agentId"] });
        resolvedAgentId = sc?.agentId ?? null;
      }
      if (!resolvedAgentId) {
        throw new Error("agent_chat job: cannot resolve agentId for lock");
      }

      const lockKey = `agent:thread:${resolvedAgentId}`;

      logger.info("Processing chat job", {
        requestId,
        userId,
        groupId,
        singleChatId,
        agentId: resolvedAgentId,
        mentionsAgent,
      });

      // Group message without @mention → store only, no agent invocation
      if (groupId && mentionsAgent === false) {
        let storeThreadId = "";
        try {
          await withThreadLock(lockRedis, lockKey, async () => {
            const threadId = await ensureCanonicalThreadId({
              userId,
              groupId: groupId ?? null,
              singleChatId: singleChatId ?? null,
            });
            storeThreadId = threadId;
            await storeMessageOnly(graph, {
              userId,
              threadId,
              message,
              groupId,
              singleChatId,
              agentId,
              displayName,
            });
            await writeConversationMessage({
              groupId: groupId ?? null,
              singleChatId: singleChatId ?? null,
              threadId,
              role: "user",
              content: message,
              senderName: displayName,
              requestId,
            });
          });
          return { threadId: storeThreadId, reply: "", systemPrompt: null };
        } catch (err: any) {
          logger.error("Store-only failed", {
            requestId,
            groupId,
            singleChatId,
            error: err?.message,
          });
          throw err;
        }
      }

      let threadIdForError: string | undefined;

      try {
        const result = await withThreadLock(lockRedis, lockKey, async () => {
          const threadId = await ensureCanonicalThreadId({
            userId,
            groupId: groupId ?? null,
            singleChatId: singleChatId ?? null,
          });
          threadIdForError = threadId;

          emitAgentTyping({
            threadId,
            userId,
            groupId: groupId ?? null,
            singleChatId: singleChatId ?? null,
          });

          await writeConversationMessage({
            groupId: groupId ?? null,
            singleChatId: singleChatId ?? null,
            threadId,
            role: "user",
            content: message,
            senderName: displayName,
            requestId,
          });

          const turnResult = await executeChatTurn(graph, {
            userId,
            threadId,
            message,
            groupId,
            singleChatId,
            agentId,
            displayName,
          });

          if (turnResult.reply) {
            await writeConversationMessage({
              groupId: groupId ?? null,
              singleChatId: singleChatId ?? null,
              threadId,
              role: "assistant",
              content: turnResult.reply,
              requestId,
              modelSlug: turnResult.modelSlug,
              vendorSlug: turnResult.vendorSlug,
              modelName: turnResult.modelName,
            });
          }

          return { turnResult, threadId };
        });

        const { turnResult, threadId } = result;

        logger.info("Chat turn completed", {
          requestId,
          threadId,
          replyLen: turnResult.reply.length,
        });

        emitAgentReply({
          requestId,
          userId,
          threadId,
          groupId: groupId ?? null,
          singleChatId: singleChatId ?? null,
          ok: true,
          reply: turnResult.reply,
          systemPrompt: turnResult.systemPrompt,
          ...(turnResult.modelSlug ? { modelSlug: turnResult.modelSlug } : {}),
          ...(turnResult.vendorSlug ? { vendorSlug: turnResult.vendorSlug } : {}),
          ...(turnResult.modelName ? { modelName: turnResult.modelName } : {}),
        });

        return turnResult;
      } catch (err: any) {
        const errorText = err?.message ?? "Agent processing failed";

        logger.error("Chat turn failed", {
          requestId,
          threadId: threadIdForError,
          error: errorText,
        });

        if (threadIdForError) {
          await writeConversationMessage({
            groupId: groupId ?? null,
            singleChatId: singleChatId ?? null,
            threadId: threadIdForError,
            role: "assistant",
            content: errorText,
            requestId,
          });

          emitAgentReply({
            requestId,
            userId,
            threadId: threadIdForError,
            groupId: groupId ?? null,
            singleChatId: singleChatId ?? null,
            ok: false,
            error: errorText,
          });
        }
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
      groupId: job?.data?.groupId,
      singleChatId: job?.data?.singleChatId,
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
