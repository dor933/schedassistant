import crypto from "node:crypto";
import { Worker } from "bullmq";
import type { CompiledStateGraph } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import {
  Roundtable,
  RoundtableAgent,
  RoundtableMessage,
  Agent,
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
import { emitAgentTyping, emitAgentReply } from "../socket";
import { logger } from "../logger";

const redisConfig = getRedisConfig();
const lockRedis = createThreadLockRedis(redisConfig);

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
        groupId,
        singleChatId,
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
          { status: "running" },
          { where: { id: roundtableId } },
        );
      }

      try {
        const result = await withThreadLock(lockRedis, lockKey, async () => {
          // Ensure the LangGraph session exists for this thread
          await ensureSession(threadId, null, { agentId });

          // Emit typing indicator
          emitAgentTyping({
            threadId,
            userId,
            groupId,
            singleChatId,
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

          const humanMsg = new HumanMessage({
            content: `[Roundtable turn — Round ${roundNumber + 1}]\n\n${turnInstruction}`,
            name: "roundtable_moderator",
          });

          const graphResult = await roundtableGraph.invoke(
            {
              userId,
              threadId,
              groupId,
              singleChatId,
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
              },
            },
            { configurable: { thread_id: threadId } },
          );

          if (graphResult.error) {
            throw new Error(graphResult.error);
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
        });

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
        const io = (() => {
          try {
            return require("../socket").getAgentIO();
          } catch {
            return null;
          }
        })();
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
            groupId,
            singleChatId,
          });

          logger.info("Roundtable: enqueued next agent in round", {
            roundtableId,
            nextAgentId: nextAgentInRound.agentId,
            roundNumber,
          });
        } else {
          // All agents spoke this round — advance to next round
          const nextRound = roundNumber + 1;

          if (nextRound >= roundtable.maxTurnsPerAgent) {
            // All rounds complete
            await Roundtable.update(
              {
                status: "completed",
                currentRound: nextRound,
                currentAgentOrderIndex: 0,
              },
              { where: { id: roundtableId } },
            );

            if (io) {
              io.emit("roundtable:completed", { roundtableId });
            }

            logger.info("Roundtable: completed all rounds", {
              roundtableId,
              totalRounds: roundtable.maxTurnsPerAgent,
            });
          } else {
            // Start next round with first agent
            const firstAgent = roundtableAgents[0];

            await Roundtable.update(
              {
                currentRound: nextRound,
                currentAgentOrderIndex: 0,
              },
              { where: { id: roundtableId } },
            );

            await roundtableQueue.add("roundtable_turn", {
              roundtableId,
              agentId: firstAgent.agentId,
              roundNumber: nextRound,
              userId,
              groupId,
              singleChatId,
            });

            logger.info("Roundtable: starting next round", {
              roundtableId,
              nextRound,
              firstAgentId: firstAgent.agentId,
            });
          }
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
          { status: "failed" },
          { where: { id: roundtableId } },
        );

        const io = (() => {
          try {
            return require("../socket").getAgentIO();
          } catch {
            return null;
          }
        })();
        if (io) {
          io.emit("roundtable:error", {
            roundtableId,
            error: errorText,
          });
        }
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
