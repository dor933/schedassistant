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
import { popConsultationOrigin } from "../consultationChain";
import { agentChatQueue } from "../queues/agentChat.bull";
import { Group, SingleChat, Agent, DeepAgentDelegation } from "@scheduling-agent/database";
import { EPIC_ORCHESTRATOR_AGENT_ID } from "../constants/epicAgent";
import { isEpicExecutionRequest } from "../utils/epicDetection";
import { isEpicOrchestratorBusy } from "../utils/epicBusyCheck";
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
  epicGraph: CompiledStateGraph<any, any, any>,
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

      // Select the correct graph for this agent
      const activeGraph =
        resolvedAgentId === EPIC_ORCHESTRATOR_AGENT_ID ? epicGraph : graph;

      // Is this an epic delegation callback? (epic orchestrator finished a delegated task)
      const isEpicDelegationCallback =
        requestId?.startsWith("epic-delegation-");

      // System-internal messages that must NEVER be bounced — they drive the
      // epic forward or are part of internal agent-to-agent chains.
      const isSystemInternalRequest =
        isEpicExecutionRequest(requestId) ||
        requestId?.startsWith("delegation-") ||
        requestId?.startsWith("consultation-chain-") ||
        requestId?.startsWith("pr-approved-");

      // ── Busy bounce ─────────────────────────────────────────────────
      // If a fresh user message arrives at the Epic Orchestrator while ANY
      // epic task is actively running (across all users — the orchestrator
      // is a shared singleton), reply immediately with a busy notice instead
      // of queueing behind the thread lock.
      if (
        resolvedAgentId === EPIC_ORCHESTRATOR_AGENT_ID &&
        mentionsAgent !== false &&
        !isSystemInternalRequest
      ) {
        try {
          const busy = await isEpicOrchestratorBusy(userId);
          if (busy.busy) {
            const threadId = await ensureCanonicalThreadId({
              userId,
              groupId: groupId ?? null,
              singleChatId: singleChatId ?? null,
            });

            const taskLabel = busy.taskTitle ? `"${busy.taskTitle}"` : "a task";
            const epicLabel = busy.epicTitle ? ` (epic: "${busy.epicTitle}")` : "";
            const ownerNote = busy.sameUser
              ? ""
              : " Another user's epic is currently running —";
            const busyMessage =
              `The Epic Orchestrator is currently executing ${taskLabel}${epicLabel}.${ownerNote} ` +
              `Only one epic can run at a time system-wide, so new requests cannot be processed until the current task finishes. ` +
              `Please try again in a few minutes.`;

            logger.info("Bouncing user message — epic orchestrator busy", {
              requestId,
              userId,
              epicId: busy.epicId,
              runningTask: busy.taskTitle,
            });

            // Persist the user's message and the busy reply so the UI reflects both
            await writeConversationMessage({
              groupId: groupId ?? null,
              singleChatId: singleChatId ?? null,
              threadId,
              role: "user",
              content: message,
              senderName: displayName,
              requestId,
            });
            await writeConversationMessage({
              groupId: groupId ?? null,
              singleChatId: singleChatId ?? null,
              threadId,
              role: "assistant",
              content: busyMessage,
              requestId,
            });

            emitAgentReply({
              requestId,
              userId,
              threadId,
              groupId: groupId ?? null,
              singleChatId: singleChatId ?? null,
              ok: true,
              reply: busyMessage,
              systemPrompt: null,
            });

            return { threadId, reply: busyMessage, systemPrompt: null };
          }
        } catch (err: any) {
          // Busy check is best-effort — if it fails, fall through to normal processing.
          logger.warn("Epic busy-check failed; proceeding normally", {
            requestId,
            error: err?.message,
          });
        }
      }

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
            await storeMessageOnly(activeGraph, {
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
            ...(isEpicExecutionRequest(requestId)
              ? { isEpicExecution: true }
              : {}),
          });

          // Delegation/consultation-chain callbacks and epic continuations are
          // internal instructions for the agent — don't persist them as visible
          // conversation messages.
          const isDelegationCallback =
            requestId?.startsWith("delegation-") ||
            requestId?.startsWith("consultation-chain-") ||
            requestId?.startsWith("epic-continuation-") ||
            isEpicDelegationCallback;

          if (!isDelegationCallback) {
            await writeConversationMessage({
              groupId: groupId ?? null,
              singleChatId: singleChatId ?? null,
              threadId,
              role: "user",
              content: message,
              senderName: displayName,
              requestId,
            });
          }

          const turnResult = await executeChatTurn(activeGraph, {
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

        // ── Epic auto-continuation ──────────────────────────────────
        // If the graph signalled that more epic tasks are ready, enqueue
        // a synthetic continuation job so the orchestrator keeps going
        // without requiring a new user message.
        if (turnResult.epicContinuation) {
          const cont = turnResult.epicContinuation;
          const contRequestId = `epic-continuation-${cont.epicId}-${Date.now()}`;

          logger.info("Enqueuing epic continuation turn", {
            epicId: cont.epicId,
            completedTask: cont.completedTaskTitle,
            remainingTasks: cont.remainingTasks,
            contRequestId,
          });

          await agentChatQueue.add("epic_continuation", {
            userId,
            message:
              `[Automatic continuation] Task "${cont.completedTaskTitle}" completed successfully. ` +
              `${cont.remainingTasks} task(s) remain in the active epic. ` +
              `Call execute_epic_task (no arguments — it auto-resolves the active epic) ` +
              `to continue with the next ready task. Provide a progress update after each task.`,
            requestId: contRequestId,
            groupId: groupId ?? null,
            singleChatId: singleChatId ?? null,
            agentId: resolvedAgentId,
            mentionsAgent: true,
            displayName: "System",
          } as any);
        }

        // Consultation chain: if this was a delegation_result and Agent B was
        // consulted by Agent A, forward Agent B's processed reply to Agent A.
        if (requestId?.startsWith("delegation-") && turnResult.reply) {
          const delegationId = requestId.replace("delegation-", "");
          const origin = await popConsultationOrigin(delegationId);
          if (origin) {
            const agentB = await Agent.findByPk(resolvedAgentId, { attributes: ["definition"] });
            const agentBName = agentB?.definition ?? resolvedAgentId;
            await agentChatQueue.add("delegation_result", {
              userId: origin.originUserId,
              message:
                `[Response from ${agentBName} — following up on delegated task]\n\n` +
                turnResult.reply,
              requestId: `consultation-chain-${delegationId}`,
              groupId: origin.originGroupId ?? null,
              singleChatId: origin.originSingleChatId ?? null,
              agentId: origin.originAgentId,
              mentionsAgent: true,
              displayName: agentBName,
            } as any);
            logger.info("Consultation chain: forwarded Agent B reply to Agent A", {
              delegationId,
              agentB: resolvedAgentId,
              originAgentId: origin.originAgentId,
            });
          }
        }

        // Epic delegation callback: the epic orchestrator finished processing
        // a delegated task — update the delegation record and notify the caller.
        if (isEpicDelegationCallback && turnResult.reply) {
          const delegationId = requestId!.replace("epic-delegation-", "");
          try {
            await DeepAgentDelegation.update(
              {
                status: "completed",
                result: turnResult.reply,
                completedAt: new Date(),
              },
              { where: { id: delegationId } },
            );

            const delegation = await DeepAgentDelegation.findByPk(delegationId, {
              attributes: ["callerAgentId", "userId", "groupId", "singleChatId"],
            });

            if (delegation) {
              await agentChatQueue.add("delegation_result", {
                userId: delegation.userId,
                message:
                  `[Epic Orchestrator — Delegation Result ${delegationId}]\n\n` +
                  turnResult.reply,
                requestId: `delegation-${delegationId}`,
                groupId: delegation.groupId ?? null,
                singleChatId: delegation.singleChatId ?? null,
                agentId: delegation.callerAgentId,
                mentionsAgent: true,
                displayName: "Epic Orchestrator",
              } as any);

              logger.info("Epic delegation completed, notifying caller", {
                delegationId,
                callerAgentId: delegation.callerAgentId,
              });
            }
          } catch (err: any) {
            logger.error("Failed to complete epic delegation callback", {
              delegationId,
              error: err?.message,
            });
          }
        }

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
        process.env.AGENT_CHAT_LOCK_DURATION_MS ?? 20 * 60 * 1000,
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
