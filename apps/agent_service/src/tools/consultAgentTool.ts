import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Agent } from "@scheduling-agent/database";
import { createThreadLockRedis, withThreadLockTimeout, LockTimeoutError } from "../worker/threadLock";
import { getRedisConfig } from "../redisClient";
import { invokeDeepAgentOneShot } from "../deepAgent/runDeepAgent";
import { saveEpisodicMemoryChunked } from "../rag/episodicMemory";
import { SaveMemoryTool, SearchMemoryTool } from "./memoryTools";
import { ListAgentsTool } from "./listAgentsTool";
import { agentNotesTools } from "./agentNotesTool";
import { workspaceTools } from "./workspaceTools";
import { logger } from "../logger";

const lockRedis = createThreadLockRedis(getRedisConfig());

/** Max time to wait for the target agent's lock (ms). */
const CONSULT_LOCK_TIMEOUT_MS = Number(
  process.env.CONSULT_AGENT_LOCK_TIMEOUT_MS ?? 60_000, // 60s default
);

/** Max time for the entire consultation to complete (ms). */
const CONSULT_EXECUTION_TIMEOUT_MS = Number(
  process.env.CONSULT_AGENT_EXECUTION_TIMEOUT_MS ?? 300_000, // 5 min default
);

/**
 * Synchronous agent-to-agent consultation.
 *
 * The target agent is invoked as a one-shot deep-agent (ephemeral checkpoint),
 * receives the caller's request as a user message, and returns its reply
 * inline. The target agent sees its full tool suite (memory + notes + workspace)
 * so it can persist anything important across its own memory.
 *
 * Safety:
 * 1. Lock per target agent — if the target is already running a turn for a chat,
 *    we wait up to `CONSULT_LOCK_TIMEOUT_MS`, then fail.
 * 2. Execution timeout — aborts after `CONSULT_EXECUTION_TIMEOUT_MS`.
 */
export function ConsultAgentTool(callerAgentId: string, userId: number) {
  return tool(
    async (input) => {
      const { targetAgentId, request } = input;

      if (targetAgentId === callerAgentId) {
        return "Error: an agent cannot consult itself.";
      }

      const targetAgent = await Agent.findByPk(targetAgentId);
      if (!targetAgent) {
        return `Error: agent "${targetAgentId}" not found.`;
      }

      const agentLabel = targetAgent.definition || targetAgentId;
      const lockKey = `agent:consult:${targetAgentId}`;

      logger.info("ConsultAgent: starting consultation", {
        callerAgentId,
        targetAgentId,
        requestLen: request.length,
      });

      try {
        const answer = await withThreadLockTimeout(
          lockRedis,
          lockKey,
          CONSULT_LOCK_TIMEOUT_MS,
          async () => {
            const tools: StructuredToolInterface[] = [
              SaveMemoryTool(targetAgent.id, userId),
              SearchMemoryTool(targetAgent.id, userId),
              ListAgentsTool(targetAgent.id),
              ...agentNotesTools(targetAgent.id),
              ...workspaceTools(targetAgent.id),
            ];

            const result = await invokeDeepAgentOneShot({
              agent: targetAgent,
              tools,
              userId,
              userMessage: `[Consultation request from another agent]\n\n${request}`,
              timeoutMs: CONSULT_EXECUTION_TIMEOUT_MS,
              recursionLimit: 40,
            });

            return result.reply;
          },
        );

        logger.info("ConsultAgent: consultation completed", {
          callerAgentId,
          targetAgentId,
          answerLen: typeof answer === "string" ? answer.length : 0,
        });

        // Auto-save the consultation transcript to the target agent's episodic
        // memory so a later conversation with that agent can recall it.
        // Short exchanges land as a single row; longer ones are chunked by a
        // cheap LLM into topic-focused memories.
        //
        // Fire-and-forget (not awaited) so the caller doesn't wait on embedding
        // + DB writes — episodic errors are logged inside the helper.
        const replyText =
          typeof answer === "string" ? answer : String(answer);
        const transcript =
          `Consultation from agent ${callerAgentId} to ${targetAgentId}.\n\n` +
          `## Their request\n${request}\n\n` +
          `## My reply\n${replyText}`;
        void saveEpisodicMemoryChunked({
          agentId: targetAgent.id,
          userId,
          content: transcript,
          metadata: {
            kind: "consultation",
            callerAgentId,
            targetAgentId,
          },
        });

        return replyText;
      } catch (err: any) {
        if (err instanceof LockTimeoutError) {
          logger.warn("ConsultAgent: target agent is busy", {
            callerAgentId,
            targetAgentId,
            timeoutMs: CONSULT_LOCK_TIMEOUT_MS,
          });
          return (
            `Agent "${agentLabel}" is currently busy processing another request and could not be reached ` +
            `within ${Math.round(CONSULT_LOCK_TIMEOUT_MS / 1000)} seconds. ` +
            `Please inform the user that the agent is occupied and suggest trying again shortly.`
          );
        }

        const isTimeout = err?.message?.includes("timed out");
        if (isTimeout) {
          logger.warn("ConsultAgent: execution timed out", {
            callerAgentId,
            targetAgentId,
            timeoutMs: CONSULT_EXECUTION_TIMEOUT_MS,
          });
          return (
            `Consultation with agent "${agentLabel}" timed out after ` +
            `${Math.round(CONSULT_EXECUTION_TIMEOUT_MS / 1000)} seconds. ` +
            `The task may be too complex for a synchronous consultation.`
          );
        }

        logger.error("ConsultAgent: consultation failed", {
          callerAgentId,
          targetAgentId,
          error: err?.message,
        });
        return `Error consulting agent "${agentLabel}": ${err?.message ?? "unknown error"}`;
      }
    },
    {
      name: "consult_agent",
      description:
        "Consult another agent for their expertise. The target agent will receive your request, " +
        "process it with its own knowledge, memory, notes, and workspace, and return an answer. " +
        "Use this when a task falls outside your specialization and another agent is better equipped to handle it. " +
        "This is a synchronous call — you will receive the answer immediately. " +
        "If the target agent is busy or the consultation takes too long, you will receive an error message.",
      schema: z.object({
        targetAgentId: z
          .string()
          .uuid()
          .describe("The ID of the agent to consult (from the agents table)."),
        request: z
          .string()
          .min(1)
          .describe("A clear, detailed description of what you need from the other agent."),
      }),
    },
  );
}
