import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Agent, DeepAgentDelegation } from "@scheduling-agent/database";
import { getDeepAgentQueue, deepAgentQueueEvents } from "../queues/deepAgent.bull";
import { logger } from "../logger";

/** Max time to block waiting for the deep agent to finish (ms). */
const SYNC_DELEGATION_TIMEOUT_MS = Number(
  process.env.SYNC_DELEGATION_TIMEOUT_MS ?? 15 * 60 * 1000, // 15 min default
);

/**
 * Synchronous deep-agent delegation tool for use in the roundtable graph.
 *
 * Same semantics as DelegateToDeepAgentTool but **blocks** until the
 * executor finishes, returning the result directly to the calling model's
 * tool loop instead of ending the turn.
 */
export function SyncDelegateToDeepAgentTool(
  callerAgentId: string,
  userId: number,
  groupId: string | null,
  singleChatId: string | null,
) {
  return tool(
    async (input) => {
      const { systemAgentSlug, request } = input;

      const executorAgent = await Agent.findOne({
        where: { slug: systemAgentSlug, type: "system" },
      });
      if (!executorAgent) {
        return `Error: system agent "${systemAgentSlug}" not found. Use list_system_agents to see available executor agents.`;
      }

      const delegation = await DeepAgentDelegation.create({
        callerAgentId,
        executorAgentId: executorAgent.id,
        userId,
        request,
        status: "pending",
        groupId,
        singleChatId,
      });

      const queue = getDeepAgentQueue();
      const job = await queue.add("deep_agent_run", {
        delegationId: delegation.id,
        executorAgentId: executorAgent.id,
        executorAgentSlug: executorAgent.slug!,
        request,
        callerAgentId,
        userId,
        groupId,
        singleChatId,
        syncMode: true,
      });

      logger.info("SyncDelegateToDeepAgent: blocking until executor finishes", {
        delegationId: delegation.id,
        callerAgentId,
        systemAgentSlug,
        bullJobId: job.id,
      });

      try {
        const resultText = await job.waitUntilFinished(
          deepAgentQueueEvents,
          SYNC_DELEGATION_TIMEOUT_MS,
        );

        logger.info("SyncDelegateToDeepAgent: executor completed", {
          delegationId: delegation.id,
          resultLen: typeof resultText === "string" ? resultText.length : 0,
        });

        return typeof resultText === "string"
          ? resultText
          : "The executor agent did not produce a text response.";
      } catch (err: any) {
        logger.error("SyncDelegateToDeepAgent: executor failed or timed out", {
          delegationId: delegation.id,
          error: err?.message,
        });

        return (
          `Executor agent "${executorAgent.agentName ?? systemAgentSlug}" failed: ${err?.message ?? "unknown error"}. ` +
          `Consider breaking the task into smaller parts or trying a different approach.`
        );
      }
    },
    {
      name: "delegate_to_deep_agent",
      description:
        "Delegate a task to an executor agent — a specialist built for complex, multi-step work. " +
        "This is a SYNCHRONOUS call — execution will block until the specialist finishes and you " +
        "will receive the result directly. Use this when a task requires sustained multi-step " +
        "execution: deep research, code generation, large data aggregation, or complex analysis. " +
        "For simple single-step lookups, use your own tools directly.",
      schema: z.object({
        systemAgentSlug: z
          .string()
          .min(1)
          .describe(
            "The slug identifier of the system agent to delegate to " +
            '(e.g. "stock_researcher_agent", "patterns_discoverer").',
          ),
        request: z
          .string()
          .min(1)
          .describe("A detailed description of the task for the executor agent, including all relevant context."),
      }),
    },
  );
}
