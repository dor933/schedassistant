import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { SystemAgent, DeepAgentDelegation } from "@scheduling-agent/database";
import { getDeepAgentQueue } from "../queues/deepAgent.bull";
import { linkDelegationToConsultation } from "../consultationChain";
import { logger } from "../logger";

/**
 * Async executor agent delegation tool (Tier 2).
 *
 * Enqueues a long-running executor agent job and returns immediately.
 * The calling agent's turn ends — the executor agent runs in the background.
 * When the executor agent finishes, a delegation_result job re-invokes the caller.
 *
 * @param callerAgentId  The agent delegating the task
 * @param userId         The user who initiated the conversation
 * @param groupId        Conversation scope (for result delivery)
 * @param singleChatId   Conversation scope (for result delivery)
 */
export function DelegateToDeepAgentTool(
  callerAgentId: string,
  userId: number,
  groupId: string | null,
  singleChatId: string | null,
) {
  return tool(
    async (input) => {
      const { systemAgentSlug, request } = input;

      const systemAgent = await SystemAgent.findOne({
        where: { slug: systemAgentSlug },
      });
      if (!systemAgent) {
        return `Error: system agent "${systemAgentSlug}" not found. Available system agents can be found in the system_agents table.`;
      }

      // Create the delegation record
      const delegation = await DeepAgentDelegation.create({
        callerAgentId,
        systemAgentId: systemAgent.id,
        userId,
        request,
        status: "pending",
        groupId,
        singleChatId,
      });

      // Enqueue the deep agent job
      const queue = getDeepAgentQueue();
      await queue.add("deep_agent_run", {
        delegationId: delegation.id,
        systemAgentId: systemAgent.id,
        systemAgentSlug: systemAgent.slug,
        request,
        callerAgentId,
        userId,
        groupId,
        singleChatId,
      });

      // If this agent is currently being consulted by another agent,
      // link the delegation so the result propagates back up the chain.
      await linkDelegationToConsultation(callerAgentId, delegation.id);

      logger.info("DelegateToDeepAgent: job enqueued", {
        delegationId: delegation.id,
        callerAgentId,
        systemAgentSlug,
        requestLen: request.length,
      });

      return (
        `Executor agent task delegated successfully.\n` +
        `- Delegation ID: ${delegation.id}\n` +
        `- Executor Agent: ${systemAgent.name} (${systemAgent.slug})\n` +
        `- Status: pending\n\n` +
        `The executor agent will process this in the background. ` +
        `You will be notified automatically when the result is ready. ` +
        `Inform the user that the task has been delegated to a specialist and they will receive an update when complete.`
      );
    },
    {
      name: "delegate_to_deep_agent",
      description:
        "Delegate a task to an executor agent — a specialist built for complex, multi-step work. " +
        "This is an ASYNCHRONOUS call — the executor agent will run in the background and you will NOT receive " +
        "the result immediately. Instead, you will be re-invoked with the result once it completes. " +
        "Use this when a task requires sustained multi-step execution: deep research, code generation, " +
        "large data aggregation, or complex analysis. For simple single-step lookups, use your own tools directly.",
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
