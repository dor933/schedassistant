import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { DeepAgentDelegation } from "@scheduling-agent/database";
import { agentChatQueue } from "../queues/agentChat.bull";
import { linkDelegationToConsultation } from "../consultationChain";
import { EPIC_ORCHESTRATOR_AGENT_ID } from "../constants/epicAgent";
import { logger } from "../logger";

/**
 * Async delegation tool targeting the Epic Orchestrator agent.
 *
 * Similar to `delegate_to_deep_agent` but routes to the epic orchestrator
 * (a primary agent with its own dedicated graph), not a system agent.
 *
 * The calling agent's turn ends immediately. The epic orchestrator processes
 * the request on its own graph and thread. When done, a delegation_result
 * job re-invokes the caller with the outcome.
 */
export function DelegateToEpicOrchestratorTool(
  callerAgentId: string,
  userId: number,
  groupId: string | null,
  singleChatId: string | null,
) {
  return tool(
    async (input) => {
      const { request } = input;

      // Create delegation record (executorAgentId = null for epic delegations)
      const delegation = await DeepAgentDelegation.create({
        callerAgentId,
        executorAgentId: null,
        userId,
        request,
        status: "pending",
        groupId,
        singleChatId,
      });

      // Enqueue to the agent chat queue — the worker routes to epicGraph
      // when it sees the epic orchestrator agent ID.
      await agentChatQueue.add("epic_delegation", {
        userId,
        message:
          `[Epic Task Delegation — ${delegation.id}]\n` +
          `Requested by another agent. Process this request:\n\n${request}`,
        requestId: `epic-delegation-${delegation.id}`,
        groupId: null,
        singleChatId: null,
        agentId: EPIC_ORCHESTRATOR_AGENT_ID,
        mentionsAgent: true,
        displayName: "delegation",
      } as any);

      // Link to consultation chain if the caller is being consulted
      await linkDelegationToConsultation(callerAgentId, delegation.id);

      logger.info("DelegateToEpicOrchestrator: job enqueued", {
        delegationId: delegation.id,
        callerAgentId,
        requestLen: request.length,
      });

      return (
        `Epic task delegated to the Epic Orchestrator.\n` +
        `- Delegation ID: ${delegation.id}\n` +
        `- Status: pending\n\n` +
        `The Epic Orchestrator will plan and execute the coding task in the background. ` +
        `You will be notified automatically when results are ready. ` +
        `Inform the user that an epic task has been delegated and they will receive progress updates.`
      );
    },
    {
      name: "delegate_to_epic_orchestrator",
      description:
        "Delegate a multi-step coding task (epic) to the Epic Orchestrator — a specialized Project Manager agent " +
        "that plans and executes coding tasks across locally cloned repositories via Claude CLI. " +
        "This is ASYNCHRONOUS — the orchestrator runs in the background and you will be re-invoked with the result. " +
        "Use this for tasks that require: creating an epic plan with stages and tasks, executing code changes " +
        "via Claude CLI, reviewing git diffs, and managing PR workflows. " +
        "Include all relevant context: what needs to be built, which project/repos, requirements, and constraints.",
      schema: z.object({
        request: z
          .string()
          .min(1)
          .describe(
            "A detailed description of the coding task for the Epic Orchestrator. " +
            "Include: what to build, which project, any specific requirements or constraints. " +
            "The orchestrator will clarify scope, plan stages/tasks, and execute them.",
          ),
      }),
    },
  );
}
