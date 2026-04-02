import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { SystemAgent, DeepAgentDelegation } from "@scheduling-agent/database";
import { getDeepAgentQueue } from "../queues/deepAgent.bull";
import { logger } from "../logger";

/**
 * Async deep agent delegation tool (Tier 2).
 *
 * Enqueues a long-running deep agent job and returns immediately.
 * The calling agent's turn ends — the deep agent runs in the background.
 * When the deep agent finishes, a delegation_result job re-invokes the caller.
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

      logger.info("DelegateToDeepAgent: job enqueued", {
        delegationId: delegation.id,
        callerAgentId,
        systemAgentSlug,
        requestLen: request.length,
      });

      return (
        `Deep agent task delegated successfully.\n` +
        `- Delegation ID: ${delegation.id}\n` +
        `- System Agent: ${systemAgent.name} (${systemAgent.slug})\n` +
        `- Status: pending\n\n` +
        `The specialist agent will process this in the background. ` +
        `You will be notified automatically when the result is ready. ` +
        `Inform the user that a deep analysis is underway and they will receive an update when complete.`
      );
    },
    {
      name: "delegate_to_deep_agent",
      description:
        "Delegate a complex, long-running task to a specialist deep agent. " +
        "Deep agents are autonomous specialists that can perform multi-step research, analysis, and complex reasoning. " +
        "This is an ASYNCHRONOUS call — the deep agent will run in the background and you will NOT receive " +
        "the result immediately. Instead, you will be re-invoked with the result once the deep agent completes. " +
        "Use this for tasks that require extensive research, multi-step analysis, or complex tool usage that " +
        "would take too long for a synchronous response.",
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
          .describe("A detailed description of the task for the deep agent, including all relevant context."),
      }),
    },
  );
}
