import { Worker } from "bullmq";
import { Op } from "sequelize";
import type { CompiledStateGraph } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  HumanMessage,
  RemoveMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  Roundtable,
  RoundtableAgent,
  RoundtableUser,
  RoundtableMessage,
  Agent,
  User,
} from "@scheduling-agent/database";
import {
  ROUNDTABLE_QUEUE_NAME,
  type RoundtableTurnJobData,
  roundtableQueue,
} from "../queues/roundtable.bull";
import { getRedisConfig } from "../redisClient";
import { createThreadLockRedis, withThreadLock } from "./threadLock";
import { ensureSession } from "../sessionsManagment/sessionRegistry";
import { resolveModelSlug } from "../chat/modelResolution";
import { emitAgentTyping, getAgentIO } from "../socket";
import { summarizeRoundtable } from "../graphs/roundtableGraph/summarizer";
import { insertEpisodicMemoryChunks } from "../rag/episodicMemoryChunksWriter";
import { getEmbedderForAgent } from "../rag/embeddings";
import {
  observeWithContext,
  getLangfuseCallbackHandler,
  flushLangfuse,
} from "../langfuse";
import { logger } from "../logger";

const redisConfig = getRedisConfig();
const lockRedis = createThreadLockRedis(redisConfig);

/** 5-minute deadline displayed to the user on the `roundtable:user_turn` event. */
export const USER_TURN_TIMEOUT_SECONDS = 5 * 60;

export type RoundtableWorkerHandle = {
  worker: Worker<RoundtableTurnJobData>;
  close: () => Promise<void>;
};

/**
 * Starts a BullMQ worker that processes `roundtable_jobs`.
 *
 * Each job represents one agent's turn in a roundtable discussion.
 * After the turn completes, the worker determines and enqueues the next
 * turn (round-robin across agents, then next round).
 */
export function startRoundtableWorker(
  roundtableGraph: CompiledStateGraph<any, any, any>,
): RoundtableWorkerHandle {
  const worker = new Worker<RoundtableTurnJobData>(
    ROUNDTABLE_QUEUE_NAME,
    async (job) => {
      const {
        roundtableId,
        agentId,
        roundNumber,
        userId,
      } = job.data;

      logger.info("Roundtable: processing turn", {
        roundtableId,
        agentId,
        roundNumber,
      });

      const roundtable = await Roundtable.findByPk(roundtableId);
      if (!roundtable || roundtable.status === "completed" || roundtable.status === "failed") {
        logger.warn("Roundtable: skipping turn — roundtable not active", {
          roundtableId,
          status: roundtable?.status,
        });
        return;
      }

      const roundtableAgents = await RoundtableAgent.findAll({
        where: { roundtableId },
        order: [["turnOrder", "ASC"]],
        include: [{ association: "agent", attributes: ["definition", "agentName"] }],
      });

      const currentRtAgent = roundtableAgents.find((ra) => ra.agentId === agentId);
      if (!currentRtAgent) {
        logger.error("Roundtable: agent not found in roundtable", {
          roundtableId,
          agentId,
        });
        return;
      }

      const agent = await Agent.findByPk(agentId, {
        attributes: ["definition", "agentName"],
      });
      const agentLabel = agent?.agentName || agent?.definition || agentId;

      const threadId = roundtable.threadId;
      const lockKey = `roundtable:thread:${roundtableId}`;

      // Mark as running on first turn
      if (roundtable.status === "pending") {
        await Roundtable.update(
          { status: "running", userTurnStartedAt: null },
          { where: { id: roundtableId } },
        );
      }

      // Load participating users (if any) ordered by turn_order so the graph
      // knows who is in the discussion and downstream logic can route turns.
      const roundtableUsers = await RoundtableUser.findAll({
        where: { roundtableId },
        order: [["turnOrder", "ASC"]],
      });
      let participantUsers: {
        id: number;
        displayName: string;
        userIdentity: any;
      }[] = [];
      if (roundtableUsers.length > 0) {
        // Exclude client-app JIT users — they should never be surfaced as
        // participants to a roundtable agent (their only valid surface is
        // the applicationGraph). Filtering at the User.findAll keeps the
        // downstream `participantUsers` list and the prompt-injected
        // identities clean without changing the row in roundtable_users.
        const userRows = await User.findAll({
          where: {
            id: roundtableUsers.map((u) => u.userId),
            authProvider: { [Op.ne]: "client_app" },
          },
          attributes: ["id", "displayName", "userIdentity"],
        });
        const byId = new Map(userRows.map((u) => [u.id, u]));
        participantUsers = roundtableUsers
          .map((ru) => byId.get(ru.userId))
          .filter((u): u is User => !!u)
          .map((u) => ({
            id: u.id,
            displayName: u.displayName?.trim() || `User #${u.id}`,
            userIdentity: u.userIdentity,
          }));
      }
      // Preserve the `participantUser` var used in the graph invoke below —
      // for backward compatibility, it points to the first participant.
      const participantUser = participantUsers[0] ?? null;

      try {
        const result = await withThreadLock(lockRedis, lockKey, async () =>
          observeWithContext(
            "roundtable_turn",
            async () => {
          // Ensure the LangGraph session exists for this thread
          await ensureSession(threadId, null, { agentId });

          // Emit typing indicator. Roundtables aren't scoped to a single chat
          // or group — the UI subscribes on `roundtableId`/`threadId` — so both
          // chat scope fields are null here.
          emitAgentTyping({
            threadId,
            userId,
            groupId: null,
            singleChatId: null,
          });

          const modelSlug = await resolveModelSlug(agentId);

          const agentOrder = roundtableAgents.map((ra) => {
            const a = (ra as any).agent;
            return {
              agentId: ra.agentId,
              definition: a?.agentName || a?.definition || ra.agentId,
            };
          });

          // Build a turn instruction as the "user message" for this agent
          const turnInstruction =
            roundNumber === 0 && currentRtAgent.turnOrder === 0
              ? `You are the first to speak in this roundtable discussion.\n\n**Topic:** ${roundtable.topic}\n\nShare your initial thoughts, analysis, and any concrete contributions from your area of expertise.`
              : `It is your turn to contribute to the roundtable discussion.\n\n**Topic:** ${roundtable.topic}\n\nReview what other participants have said and add your perspective. Build on previous contributions and provide new insights from your expertise.`;

          // Tag the moderator HumanMessage with the agent it is addressed to and
          // the round number. The roundtable graph uses this metadata to attribute
          // each turn block in the shared thread to its owning agent so peers'
          // prior replies don't read as the current agent's own past output.
          const humanMsg = new HumanMessage({
            content: `[Roundtable turn — Round ${roundNumber + 1}]\n\n${turnInstruction}`,
            name: "roundtable_moderator",
            additional_kwargs: { agentId, roundNumber },
          });

          const langfuseHandler = getLangfuseCallbackHandler(userId, {
            threadId,
            roundtableId,
            agentId,
            roundNumber,
            modelSlug,
            agentLabel,
            service: "agent_service",
            graph: "roundtable",
          });

          const graphResult = await roundtableGraph.invoke(
            {
              userId,
              threadId,
              groupId: null,
              singleChatId: null,
              agentId,
              modelSlug,
              userInput: turnInstruction,
              messages: [humanMsg],
              roundtableId,
              roundtableConfig: {
                topic: roundtable.topic,
                roundNumber,
                maxTurnsPerAgent: roundtable.maxTurnsPerAgent,
                agentOrder,
                includeUser: roundtable.includeUser,
                participantUser,
                participantUsers,
              },
            },
            {
              configurable: { thread_id: threadId },
              ...(langfuseHandler
                ? {
                    callbacks: [langfuseHandler] as RunnableConfig["callbacks"],
                  }
                : {}),
            } as RunnableConfig,
          );

          if (graphResult.error) {
            throw new Error(typeof graphResult.error === 'string' ? graphResult.error : JSON.stringify(graphResult.error));
          }

          // Extract the last AI message as the agent's reply
          const messages: any[] = Array.isArray(graphResult.messages)
            ? graphResult.messages
            : [];
          const lastAi = [...messages]
            .reverse()
            .find(
              (m: any) =>
                (typeof m._getType === "function" && m._getType() === "ai") ||
                m.role === "assistant",
            );

          const rawContent = lastAi?.content;
          let reply: string;
          if (typeof rawContent === "string") {
            reply = rawContent;
          } else if (Array.isArray(rawContent)) {
            reply =
              rawContent
                .filter((b: any) => b?.type === "text" && typeof b.text === "string")
                .map((b: any) => b.text)
                .join("\n") || "The agent did not produce a text response.";
          } else {
            reply = "The agent did not produce a response.";
          }

          return reply;
            },
            {
              roundtableId,
              agentId,
              agentLabel,
              roundNumber,
              userId,
              topicPreview:
                typeof roundtable.topic === "string"
                  ? roundtable.topic.substring(0, 200)
                  : "",
            },
          ),
        );

        // Save the agent's reply as a roundtable message for the UI
        await RoundtableMessage.create({
          roundtableId,
          agentId,
          roundNumber,
          content: result,
        });

        // Increment turnsCompleted for this agent
        await RoundtableAgent.update(
          { turnsCompleted: currentRtAgent.turnsCompleted + 1 },
          { where: { id: currentRtAgent.id } },
        );

        // Emit the message via Socket.IO
        let io: ReturnType<typeof getAgentIO> | null = null;
        try { io = getAgentIO(); } catch { /* socket not yet initialized */ }

        if (io) {
          io.emit("roundtable:message", {
            roundtableId,
            agentId,
            agentLabel,
            roundNumber,
            content: result,
            createdAt: new Date().toISOString(),
          });
        }

        logger.info("Roundtable: turn completed", {
          roundtableId,
          agentId,
          roundNumber,
          replyLen: result.length,
        });

        // ── Determine next turn ──────────────────────────────────────────
        const currentOrderIndex = currentRtAgent.turnOrder;
        const nextAgentInRound = roundtableAgents.find(
          (ra) => ra.turnOrder > currentOrderIndex,
        );

        if (nextAgentInRound) {
          // More agents in this round
          await Roundtable.update(
            { currentAgentOrderIndex: nextAgentInRound.turnOrder },
            { where: { id: roundtableId } },
          );

          await roundtableQueue.add("roundtable_turn", {
            roundtableId,
            agentId: nextAgentInRound.agentId,
            roundNumber,
            userId,
          });

          logger.info("Roundtable: enqueued next agent in round", {
            roundtableId,
            nextAgentId: nextAgentInRound.agentId,
            roundNumber,
          });
        } else {
          // All agents spoke this round.
          if (roundtableUsers.length > 0) {
            // Users take their turns after the agents. Find the first user who
            // hasn't spoken in this round (turnsCompleted == roundNumber).
            const nextUser = roundtableUsers.find(
              (u) => u.turnsCompleted <= roundNumber,
            );
            if (nextUser) {
              // Stamp the turn-window opener so a refresh / reconnect can
              // recompute the same deadline that the socket event carries.
              await Roundtable.update(
                {
                  status: "waiting_for_user",
                  userTurnStartedAt: new Date(),
                },
                { where: { id: roundtableId } },
              );

              const nextUserProfile = participantUsers.find(
                (p) => p.id === nextUser.userId,
              );

              if (io) {
                io.emit("roundtable:user_turn", {
                  roundtableId,
                  roundNumber,
                  userId: nextUser.userId,
                  displayName: nextUserProfile?.displayName ?? null,
                  deadlineSeconds: USER_TURN_TIMEOUT_SECONDS,
                });
              }

              logger.info("Roundtable: awaiting user turn", {
                roundtableId,
                roundNumber,
                userId: nextUser.userId,
              });
              return;
            }
          }

          await advanceRoundOrComplete({
            roundtable,
            roundtableAgents,
            completedRoundNumber: roundNumber,
            userId,
            io,
          });
        }
      } catch (err: any) {
        const errorText = err?.message ?? "Roundtable turn failed";
        logger.error("Roundtable: turn failed", {
          roundtableId,
          agentId,
          roundNumber,
          error: errorText,
        });

        await Roundtable.update(
          { status: "failed", userTurnStartedAt: null },
          { where: { id: roundtableId } },
        );

        try {
          getAgentIO().emit("roundtable:error", {
            roundtableId,
            error: errorText,
          });
        } catch {
          // Socket not yet initialized
        }
      } finally {
        // Flush Langfuse traces so each turn's observation lands even if the
        // worker process is recycled before the next turn fires.
        await flushLangfuse();
      }
    },
    {
      connection: redisConfig,
      concurrency: Number(process.env.ROUNDTABLE_WORKER_CONCURRENCY ?? "2"),
      lockDuration: Number(
        process.env.ROUNDTABLE_LOCK_DURATION_MS ?? 30 * 60 * 1000,
      ),
    },
  );

  worker.on("failed", (job, err) => {
    logger.error("Roundtable BullMQ job failed", {
      bullJobId: job?.id,
      roundtableId: job?.data?.roundtableId,
      error: err?.message ?? String(err),
    });
  });

  logger.info("Roundtable worker listening", {
    queue: ROUNDTABLE_QUEUE_NAME,
    concurrency: Number(process.env.ROUNDTABLE_WORKER_CONCURRENCY ?? "2"),
  });

  return {
    worker,
    close: async () => {
      await worker.close();
      await lockRedis.quit();
    },
  };
}

// ─── Round advancement helper (shared with user-turn submission) ────────────

type IO = ReturnType<typeof getAgentIO> | null;

async function advanceRoundOrComplete(params: {
  roundtable: Roundtable;
  roundtableAgents: RoundtableAgent[];
  completedRoundNumber: number;
  userId: number;
  io: IO;
}): Promise<void> {
  const {
    roundtable,
    roundtableAgents,
    completedRoundNumber,
    userId,
    io,
  } = params;

  const roundtableId = roundtable.id;
  const threadId = roundtable.threadId;
  const nextRound = completedRoundNumber + 1;

  if (nextRound >= roundtable.maxTurnsPerAgent) {
    const summary = await generateAndPersistSummary({
      roundtableId,
      threadId,
      userId,
      participantAgentIds: roundtableAgents.map((ra) => ra.agentId),
      topic: roundtable.topic,
    });

    await Roundtable.update(
      {
        status: "completed",
        currentRound: nextRound,
        currentAgentOrderIndex: 0,
        userTurnStartedAt: null,
      },
      { where: { id: roundtableId } },
    );

    if (io) {
      io.emit("roundtable:completed", {
        roundtableId,
        summary,
        summaryGeneratedAt: new Date().toISOString(),
      });
    }

    logger.info("Roundtable: completed all rounds", {
      roundtableId,
      totalRounds: roundtable.maxTurnsPerAgent,
      summaryLen: summary?.length ?? 0,
    });
    return;
  }

  const firstAgent = roundtableAgents[0];

  await Roundtable.update(
    {
      status: "running",
      currentRound: nextRound,
      currentAgentOrderIndex: 0,
      userTurnStartedAt: null,
    },
    { where: { id: roundtableId } },
  );

  await roundtableQueue.add("roundtable_turn", {
    roundtableId,
    agentId: firstAgent.agentId,
    roundNumber: nextRound,
    userId,
  });

  logger.info("Roundtable: starting next round", {
    roundtableId,
    nextRound,
    firstAgentId: firstAgent.agentId,
  });
}

// ─── User-turn submission (called by HTTP route) ────────────────────────────

/**
 * Handles the participating user's submission for the current round.
 *
 * Responsibilities:
 *   1. Validate that the roundtable is actually waiting for the user.
 *   2. Persist the user's message as a `RoundtableMessage` row.
 *   3. Inject a `HumanMessage` into the LangGraph thread so downstream agents
 *      see the user's contribution in subsequent turns.
 *   4. Emit `roundtable:message` with senderType=user for UI rendering.
 *   5. Either start the next round or finalize the roundtable.
 */
export async function submitRoundtableUserTurn(
  roundtableGraph: CompiledStateGraph<any, any, any>,
  params: { roundtableId: string; userId: number; content: string },
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { roundtableId, userId, content } = params;

  const roundtable = await Roundtable.findByPk(roundtableId);
  if (!roundtable) {
    return { ok: false, status: 404, error: "Roundtable not found" };
  }
  if (roundtable.status !== "waiting_for_user") {
    return {
      ok: false,
      status: 400,
      error: `Roundtable is not waiting for user input (status=${roundtable.status})`,
    };
  }

  const participants = await RoundtableUser.findAll({
    where: { roundtableId },
    order: [["turnOrder", "ASC"]],
  });
  if (participants.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "Roundtable has no user participants",
    };
  }

  const roundNumber = roundtable.currentRound;
  const activeParticipant = participants.find(
    (p) => p.turnsCompleted <= roundNumber,
  );
  if (!activeParticipant) {
    return {
      ok: false,
      status: 400,
      error: "No active user turn awaiting submission",
    };
  }
  if (activeParticipant.userId !== userId) {
    return {
      ok: false,
      status: 403,
      error: "It is not your turn yet",
    };
  }

  const userRow = await User.findByPk(userId, {
    attributes: ["id", "displayName"],
  });
  const displayName = userRow?.displayName?.trim() || `User #${userId}`;

  const text = typeof content === "string" ? content.trim() : "";
  const safeContent = text.length > 0 ? text : "(This participant chose to skip this round.)";

  // 1. Persist the user message.
  await RoundtableMessage.create({
    roundtableId,
    agentId: null,
    userId,
    roundNumber,
    content: safeContent,
  });

  // 2. Increment this user's turnsCompleted so subsequent logic skips them.
  await RoundtableUser.update(
    { turnsCompleted: activeParticipant.turnsCompleted + 1 },
    { where: { id: activeParticipant.id } },
  );

  // 3. Inject into LangGraph thread state so agents (and other users) see it.
  try {
    const sanitizedName = sanitizeSenderName(displayName);
    await roundtableGraph.updateState(
      { configurable: { thread_id: roundtable.threadId } },
      {
        messages: [
          new HumanMessage({
            content: `[${displayName} — round ${roundNumber + 1} user contribution]\n\n${safeContent}`,
            name: sanitizedName,
          }),
        ],
      },
    );
  } catch (err: any) {
    logger.error("Roundtable: failed to inject user message into thread state", {
      roundtableId,
      error: err?.message ?? String(err),
    });
  }

  // 4. Emit socket event so all clients render the user's message.
  let io: IO = null;
  try {
    io = getAgentIO();
  } catch {
    /* socket not initialized */
  }
  if (io) {
    io.emit("roundtable:message", {
      roundtableId,
      agentId: null,
      agentLabel: displayName,
      senderType: "user",
      userId,
      displayName,
      roundNumber,
      content: safeContent,
      createdAt: new Date().toISOString(),
    });
  }

  // 5. Determine next step: another user to speak this round, or advance.
  const nextParticipant = participants.find(
    (p) =>
      p.id !== activeParticipant.id &&
      p.turnsCompleted <= roundNumber &&
      p.turnOrder > activeParticipant.turnOrder,
  );

  if (nextParticipant) {
    // Another participant still owes a turn this round.
    const nextRow = await User.findByPk(nextParticipant.userId, {
      attributes: ["id", "displayName"],
    });
    const nextDisplayName =
      nextRow?.displayName?.trim() || `User #${nextParticipant.userId}`;

    // Re-stamp the turn-window opener for the next user — same reason as
    // the worker's first emit: the GET /roundtables/:id response derives
    // the deadline from this column, and a refresh between handoffs
    // would otherwise carry the previous user's start time forward.
    await Roundtable.update(
      { userTurnStartedAt: new Date() },
      { where: { id: roundtableId } },
    );

    // status already == "waiting_for_user"; just emit the next prompt.
    if (io) {
      io.emit("roundtable:user_turn", {
        roundtableId,
        roundNumber,
        userId: nextParticipant.userId,
        displayName: nextDisplayName,
        deadlineSeconds: USER_TURN_TIMEOUT_SECONDS,
      });
    }

    logger.info("Roundtable: handed off to next user", {
      roundtableId,
      roundNumber,
      userId: nextParticipant.userId,
    });

    return { ok: true };
  }

  // 6. All users spoke — advance to next round (or finalize).
  const roundtableAgents = await RoundtableAgent.findAll({
    where: { roundtableId },
    order: [["turnOrder", "ASC"]],
    include: [{ association: "agent", attributes: ["definition", "agentName"] }],
  });

  await advanceRoundOrComplete({
    roundtable,
    roundtableAgents,
    completedRoundNumber: roundNumber,
    userId,
    io,
  });

  logger.info("Roundtable: user turn processed", {
    roundtableId,
    roundNumber,
    userId,
    contentLen: safeContent.length,
  });

  return { ok: true };
}

function sanitizeSenderName(raw: string): string {
  return raw.replace(/[\s<|\\/>]+/g, "_").replace(/^_+|_+$/g, "") || "user";
}

// ─── End-of-roundtable summary pipeline ──────────────────────────────────────

/**
 * Generates the final summary via a one-off LLM call, persists it on the
 * `roundtables` row, and pushes one episodic-memory chunk per participating
 * agent so each participant retains cross-thread recall of the discussion.
 *
 * All downstream failures are logged but never escalated — a failed summary
 * must not prevent the roundtable from transitioning to "completed".
 * Returns the summary text (or null if generation failed).
 */
async function generateAndPersistSummary(params: {
  roundtableId: string;
  threadId: string;
  userId: number;
  participantAgentIds: string[];
  topic: string;
}): Promise<string | null> {
  const { roundtableId, threadId, userId, participantAgentIds, topic } = params;

  let summary: string;
  let shortSummary: string | null = null;
  try {
    const result = await summarizeRoundtable(roundtableId, { userId });
    summary = result.summary;
    shortSummary = result.shortSummary;
  } catch (err: any) {
    logger.error("Roundtable: summary generation failed", {
      roundtableId,
      error: err?.message ?? String(err),
    });
    return null;
  }

  try {
    await Roundtable.update(
      {
        summary,
        shortSummary,
        summaryGeneratedAt: new Date(),
      },
      { where: { id: roundtableId } },
    );
  } catch (err: any) {
    logger.error("Roundtable: failed to persist summary on roundtable row", {
      roundtableId,
      error: err?.message ?? String(err),
    });
  }

  // One episodic-memory row per participating agent so each can recall the
  // discussion in any future thread. Uses the roundtable's thread_id as the
  // provenance pointer. Each agent's org pays for its own embedding — looking
  // up an embedder per agentId preserves that per-tenant billing even when a
  // roundtable spans agents from different orgs.
  await Promise.all(
    participantAgentIds.map(async (agentId) => {
      try {
        const embedder = await getEmbedderForAgent(agentId);
        await insertEpisodicMemoryChunks(
          threadId,
          userId,
          agentId,
          [summary],
          embedder.embedText,
          {
            source: "roundtable_summary",
            extraMetadata: { roundtableId, topic },
          },
        );
      } catch (err: any) {
        logger.error("Roundtable: failed to push summary into episodic memory", {
          roundtableId,
          agentId,
          error: err?.message ?? String(err),
        });
      }
    }),
  );

  return summary;
}

// ─── Resume after failure ───────────────────────────────────────────────────

/**
 * Walks `messages` from the end backwards and returns the index of the last
 * "clean turn boundary" — a point at which the LangGraph thread can be safely
 * continued. Anything after that index is orphan content from a failed turn
 * (e.g. a moderator HumanMessage with no AI reply, an AIMessage with
 * tool_calls whose ToolMessage never arrived, or partial tool results).
 *
 * A clean boundary is either:
 *   - an AIMessage with non-empty text content and no pending tool_calls
 *     (a completed reply), or
 *   - a HumanMessage whose name is NOT "roundtable_moderator" (a user
 *     contribution submitted via the user-turn route).
 *
 * Returns -1 when no clean boundary exists, in which case the entire
 * checkpoint should be cleared.
 */
function findCleanCheckpointBoundary(messages: BaseMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m: any = messages[i];
    const t =
      typeof m?._getType === "function" ? m._getType() : m?.role ?? m?._type;
    if (t === "ai" || t === "assistant") {
      const tcs = m.tool_calls;
      const hasToolCalls = Array.isArray(tcs) && tcs.length > 0;
      const text = extractMessageText(m.content);
      if (!hasToolCalls && text.trim().length > 0) return i;
    } else if (t === "human" || t === "user") {
      if (m.name && m.name !== "roundtable_moderator") return i;
    }
  }
  return -1;
}

function extractMessageText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const part of content) {
    if (typeof part === "string") out.push(part);
    else if (
      part &&
      typeof part === "object" &&
      "text" in part &&
      typeof (part as { text: unknown }).text === "string"
    ) {
      out.push((part as { text: string }).text);
    }
  }
  return out.join("\n");
}

/**
 * Resume a roundtable that was previously marked `failed`.
 *
 * Trims trailing orphan messages from the LangGraph checkpoint (so the next
 * invoke does not start mid-tool-call), flips the roundtable status back to
 * `running`, and re-enqueues a `roundtable_turn` job for the agent who was
 * mid-flight when the failure occurred (`currentAgentOrderIndex` /
 * `currentRound`).
 *
 * The checkpoint and `RoundtableMessage` rows survive the failure, so
 * verbatim history of completed turns comes back automatically once the
 * re-enqueued turn runs.
 */
export async function resumeRoundtable(
  roundtableGraph: CompiledStateGraph<any, any, any>,
  params: { roundtableId: string },
): Promise<
  | { ok: true; agentId: string; round: number; trimmedMessages: number }
  | { ok: false; status: number; error: string }
> {
  const { roundtableId } = params;

  const roundtable = await Roundtable.findByPk(roundtableId);
  if (!roundtable) {
    return { ok: false, status: 404, error: "Roundtable not found" };
  }
  if (roundtable.status !== "failed") {
    return {
      ok: false,
      status: 400,
      error: `Roundtable is not in failed state (status=${roundtable.status})`,
    };
  }

  const threadId = roundtable.threadId;
  const config = { configurable: { thread_id: threadId } };

  // 1. Trim trailing orphan messages so the next invoke does not start with
  //    a half-finished tool sequence that providers will reject.
  let trimmedMessages = 0;
  try {
    const stateTuple = await roundtableGraph.getState(config);
    const messages: BaseMessage[] =
      (stateTuple?.values?.messages as BaseMessage[]) ?? [];
    if (messages.length > 0) {
      const boundary = findCleanCheckpointBoundary(messages);
      const orphans = messages.slice(boundary + 1);
      const removeIds = orphans
        .map((m) => (m as any).id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      if (removeIds.length > 0) {
        await roundtableGraph.updateState(config, {
          messages: removeIds.map((id) => new RemoveMessage({ id })),
        });
        trimmedMessages = removeIds.length;
      }
      if (orphans.length !== removeIds.length) {
        logger.warn(
          "Roundtable resume: some orphan messages had no id and could not be trimmed",
          {
            roundtableId,
            orphanCount: orphans.length,
            trimmable: removeIds.length,
          },
        );
      }
    }
  } catch (err: any) {
    logger.error("Roundtable resume: checkpoint trim failed", {
      roundtableId,
      error: err?.message ?? String(err),
    });
    return {
      ok: false,
      status: 500,
      error: "Failed to clean checkpoint state",
    };
  }

  // 2. Locate the agent at currentAgentOrderIndex — the one who was running
  //    (or about to run) when the failure happened.
  const roundtableAgents = await RoundtableAgent.findAll({
    where: { roundtableId },
    order: [["turnOrder", "ASC"]],
  });
  const currentAgent = roundtableAgents.find(
    (ra) => ra.turnOrder === roundtable.currentAgentOrderIndex,
  );
  if (!currentAgent) {
    return {
      ok: false,
      status: 500,
      error: `No agent at turnOrder=${roundtable.currentAgentOrderIndex}`,
    };
  }

  // 3. Reset status and re-enqueue the failed turn. Use the roundtable
  //    creator as the userId — that field is required by the job payload
  //    and matches the original `start` route's behavior.
  await Roundtable.update(
    { status: "running", userTurnStartedAt: null },
    { where: { id: roundtableId } },
  );

  await roundtableQueue.add("roundtable_turn", {
    roundtableId,
    agentId: currentAgent.agentId,
    roundNumber: roundtable.currentRound,
    userId: roundtable.createdBy,
  });

  logger.info("Roundtable resumed", {
    roundtableId,
    agentId: currentAgent.agentId,
    round: roundtable.currentRound,
    trimmedMessages,
  });

  return {
    ok: true,
    agentId: currentAgent.agentId,
    round: roundtable.currentRound,
    trimmedMessages,
  };
}
