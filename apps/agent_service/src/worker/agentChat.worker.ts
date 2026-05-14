import crypto from "node:crypto";
import { Worker } from "bullmq";
import type { CompiledStateGraph } from "@langchain/langgraph";

import {
  AGENT_CHAT_QUEUE_NAME,
  type AgentChatJobData,
  type AgentChatJobResult,
} from "../queues/agentChat.bull";
import { getRedisConfig } from "../redisClient";
import { executeChatTurn, storeMessageOnly } from "../chat/executeChatTurn";
import { createThreadLockRedis, withThreadLock, withThreadLockTimeout, LockTimeoutError } from "./threadLock";
import { emitAgentReply, emitAgentTyping } from "../socket";
import { ensureCanonicalThreadId } from "../sessionsManagment/canonicalThread";
import { ensureSession } from "../sessionsManagment/sessionRegistry";
import { writeConversationMessage } from "../sessionsManagment/conversationMessageWriter";
import { popConsultationOrigin } from "../consultationChain";
import { agentChatQueue } from "../queues/agentChat.bull";
import { Group, SingleChat, Agent, DeepAgentDelegation } from "@scheduling-agent/database";
import { EPIC_ORCHESTRATOR_DEFINITION } from "../constants/epicAgent";
import { isEpicExecutionRequest } from "../utils/epicDetection";
import { saveUserAttachmentToAgentWorkspace, buildAttachmentUrl } from "../tools/sendFileTool";
import { logger } from "../logger";

const redisConfig = getRedisConfig();
const lockRedis = createThreadLockRedis(redisConfig);

/** How long a user-facing message waits for the thread lock before bouncing. */
const USER_LOCK_WAIT_TIMEOUT_MS = Number(
  process.env.AGENT_CHAT_USER_LOCK_WAIT_TIMEOUT_MS ?? "30000",
);

async function ensureAgentActiveThreadId(agentId: string): Promise<string> {
  const agent = await Agent.findByPk(agentId, {
    attributes: ["id", "activeThreadId"],
  });
  if (!agent) {
    throw Object.assign(new Error("Agent not found."), { status: 404 });
  }
  if (agent.activeThreadId) {
    return agent.activeThreadId;
  }

  const threadId = crypto.randomUUID();
  await ensureSession(threadId, null, { agentId: agent.id });
  await Agent.update(
    { activeThreadId: threadId },
    { where: { id: agent.id } },
  );
  logger.info("Created canonical thread (internal callback)", {
    threadId,
    agentId: agent.id,
  });
  return threadId;
}

async function buildDelegationRotationContext(
  requestId: string | undefined,
  currentThreadId: string,
): Promise<string | null> {
  if (!requestId?.startsWith("delegation-")) {
    return null;
  }

  const delegationId = requestId.replace("delegation-", "");
  const delegation = await DeepAgentDelegation.findByPk(delegationId, {
    attributes: ["callerThreadId"],
  });
  const callerThreadId = delegation?.callerThreadId ?? null;
  if (!callerThreadId || callerThreadId === currentThreadId) {
    return null;
  }

  return (
    `[Delegation context]\n` +
    `This delegation was initiated on caller thread ${callerThreadId}, ` +
    `but the caller's current active thread is ${currentThreadId}. ` +
    `Executor workspace artifacts for this delegation, if any, were written ` +
    `under \`threads/${callerThreadId}/\` in this agent's workspace. Use that ` +
    `thread folder when referencing files from the delegated work.`
  );
}

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
        message: rawMessage,
        groupId,
        singleChatId,
        agentId,
        requestId,
        mentionsAgent,
        displayName,
        attachment,
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

      // ── User attachment: save into agent workspace, build two views ──
      // `graphMessage` is what the LLM sees (raw typed text + file contents).
      // `storedContent` is what we persist to conversation_messages and what
      // the chat UI renders — a clickable attachment chip plus the typed
      // message. The file lands in the agent's workspace so subsequent turns
      // can read it via `workspace_read_file` and the UI can download it via
      // the signed attachment URL.
      let graphMessage = rawMessage ?? "";
      let storedContent = rawMessage ?? "";
      if (attachment?.fileName && attachment?.content) {
        try {
          const saved = await saveUserAttachmentToAgentWorkspace(
            resolvedAgentId,
            attachment.fileName,
            attachment.content,
          );
          const trimmed = (rawMessage ?? "").trim();

          // ALWAYS wrap the graph message with file contents once we've saved
          // the file — the agent's awareness of the attachment must not depend
          // on whether URL signing succeeds.
          graphMessage =
            `📎 The user attached a file. It has been saved to your workspace as ` +
            `\`${saved.savedFileName}\` — you can re-read it later with the filesystem MCP ` +
            `\`read_text_file\` tool using your WORKSPACE_PATH prefix. File contents are below.\n\n` +
            `--- BEGIN ${saved.savedFileName} ---\n${attachment.content}\n--- END ${saved.savedFileName} ---` +
            (trimmed ? `\n\n${rawMessage}` : "");

          // Try to build a signed download URL for the UI chip. If signing is
          // misconfigured (e.g. ATTACHMENT_SIGNING_SECRET unset), fall back to
          // a plain-text marker — the agent still sees the contents, the user
          // just loses the clickable download until the secret is configured.
          let chipMarkdown: string;
          try {
            const url = buildAttachmentUrl(
              resolvedAgentId,
              saved.savedFileName,
            );
            chipMarkdown = `[📎 ${saved.savedFileName}](${url})`;
          } catch (urlErr: any) {
            logger.warn(
              "Attachment URL signing failed; storing plain-text marker",
              {
                requestId,
                agentId: resolvedAgentId,
                fileName: saved.savedFileName,
                error: urlErr?.message,
              },
            );
            chipMarkdown = `📎 ${saved.savedFileName}`;
          }
          storedContent = trimmed
            ? `${chipMarkdown}\n\n${rawMessage}`
            : chipMarkdown;
        } catch (err: any) {
          logger.error("Attachment save failed, dropping attachment", {
            requestId,
            agentId: resolvedAgentId,
            fileName: attachment.fileName,
            error: err?.message,
          });
          // Fall through without an attachment — the typed message still
          // goes to the agent.
        }
      }
      const message = graphMessage;

      const lockKey = `agent:thread:${resolvedAgentId}`;

      // Every org has its OWN Epic Orchestrator, identified by definition
      // string (not a global singleton UUID). Look up the agent record once
      // so we can route to epicGraph for any org's orchestrator.
      const resolvedAgentRecord = await Agent.findByPk(resolvedAgentId, {
        attributes: ["id", "definition"],
      });
      const isEpicOrchestrator =
        resolvedAgentRecord?.definition === EPIC_ORCHESTRATOR_DEFINITION;

      logger.info("Processing chat job", {
        requestId,
        userId,
        groupId,
        singleChatId,
        agentId: resolvedAgentId,
        mentionsAgent,
      });

      // Select the correct graph for this agent
      const activeGraph = isEpicOrchestrator ? epicGraph : graph;

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
      const shouldUseAgentActiveThread =
        isSystemInternalRequest && !groupId && !singleChatId;

      // (Removed: busy-bounce that auto-replied "The Epic Orchestrator is
      // currently executing ..." whenever any task was in_progress system-wide.
      // It blocked the user from talking to the orchestrator while a task was
      // mid-flight, including to instruct a retry or call `reset_stuck_task`.
      // The thread lock + per-task pause already serialise execution, and
      // `reset_stuck_task` is the recovery path for genuine orphans.)

      // Group message without @mention → store only, no agent invocation
      if (groupId && mentionsAgent === false) {
        let storeThreadId = "";
        try {
          await withThreadLockTimeout(lockRedis, lockKey, USER_LOCK_WAIT_TIMEOUT_MS, async () => {
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
              content: storedContent,
              senderName: displayName,
              requestId,
            });
          });
          return { threadId: storeThreadId, reply: "", systemPrompt: null };
        } catch (err: any) {
          if (err instanceof LockTimeoutError) {
            logger.warn("Store-only timed out waiting for thread lock", {
              requestId,
              groupId,
              lockKey,
            });
            // Still persist the message in the conversation DB so the user sees it in the UI,
            // even though it couldn't be written to the LangGraph thread.
            const threadId = await ensureCanonicalThreadId({
              userId,
              groupId: groupId ?? null,
              singleChatId: singleChatId ?? null,
            });
            await writeConversationMessage({
              groupId: groupId ?? null,
              singleChatId: singleChatId ?? null,
              threadId,
              role: "user",
              content: storedContent,
              senderName: displayName,
              requestId,
            });
            return { threadId, reply: "", systemPrompt: null };
          }
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

      // System-internal messages block indefinitely — they must eventually
      // complete.  User-facing messages get a timeout so the user isn't left
      // waiting forever when the agent is busy with another conversation.
      const acquireLock = isSystemInternalRequest
        ? <T>(fn: () => Promise<T>) => withThreadLock(lockRedis, lockKey, fn)
        : <T>(fn: () => Promise<T>) => withThreadLockTimeout(lockRedis, lockKey, USER_LOCK_WAIT_TIMEOUT_MS, fn);

      try {
        const result = await acquireLock(async () => {
          const threadId = shouldUseAgentActiveThread
            ? await ensureAgentActiveThreadId(resolvedAgentId)
            : await ensureCanonicalThreadId({
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
              content: storedContent,
              senderName: displayName,
              requestId,
            });
          }

          const delegationRotationContext = await buildDelegationRotationContext(
            requestId,
            threadId,
          );
          const turnMessage = delegationRotationContext
            ? `${delegationRotationContext}\n\n${message}`
            : message;

          const turnResult = await executeChatTurn(activeGraph, {
            userId,
            threadId,
            message: turnMessage,
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
        // ── Agent busy bounce ────────────────────────────────────────
        if (err instanceof LockTimeoutError) {
          logger.info("Bouncing user message — agent busy (lock timeout)", {
            requestId,
            userId,
            groupId,
            singleChatId,
            lockKey,
          });

          const threadId = await ensureCanonicalThreadId({
            userId,
            groupId: groupId ?? null,
            singleChatId: singleChatId ?? null,
          });

          const busyMessage =
            "The agent is currently busy with another conversation. " +
            "Please try again in a few moments.";

          await writeConversationMessage({
            groupId: groupId ?? null,
            singleChatId: singleChatId ?? null,
            threadId,
            role: "user",
            content: storedContent,
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
