import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Agent, DeepAgentDelegation } from "@scheduling-agent/database";
import { getDeepAgentQueue } from "../queues/deepAgent.bull";
import { linkDelegationToConsultation } from "../consultationChain";
import { logger } from "../logger";

/** Slug of the web search system agent — kept in sync with migration 0044. */
const WEB_SEARCH_SYSTEM_AGENT_SLUG = "web_search";

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

      const executorAgent = await Agent.findOne({
        where: { slug: systemAgentSlug, type: "system" },
      });
      if (!executorAgent) {
        return `Error: system agent "${systemAgentSlug}" not found. Use list_system_agents to see available executor agents.`;
      }

      // Create the delegation record
      const delegation = await DeepAgentDelegation.create({
        callerAgentId,
        executorAgentId: executorAgent.id,
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
        executorAgentId: executorAgent.id,
        executorAgentSlug: executorAgent.slug!,
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
        `- Executor Agent: ${executorAgent.agentName} (${executorAgent.slug})\n` +
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

/**
 * Purpose-built web-search delegation tool for the Epic Orchestrator.
 *
 * Hardcodes the target system agent to `web_search` — the LLM cannot pick
 * any other system agent through this tool.
 */
export function DelegateWebSearchTool(
  callerAgentId: string,
  userId: number,
  groupId: string | null,
  singleChatId: string | null,
) {
  return tool(
    async (input) => {
      const { request } = input;

      const executorAgent = await Agent.findOne({
        where: { slug: WEB_SEARCH_SYSTEM_AGENT_SLUG, type: "system" },
      });
      if (!executorAgent) {
        return (
          `Error: the web_search system agent is not configured in this environment. ` +
          `Contact the administrator to seed the web_search system agent.`
        );
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
      await queue.add("deep_agent_run", {
        delegationId: delegation.id,
        executorAgentId: executorAgent.id,
        executorAgentSlug: executorAgent.slug!,
        request,
        callerAgentId,
        userId,
        groupId,
        singleChatId,
      });

      await linkDelegationToConsultation(callerAgentId, delegation.id);

      logger.info("DelegateWebSearch: job enqueued", {
        delegationId: delegation.id,
        callerAgentId,
        requestLen: request.length,
      });

      return (
        `Web search delegated successfully.\n` +
        `- Delegation ID: ${delegation.id}\n` +
        `- Target: Web Search Agent (${executorAgent.slug})\n` +
        `- Status: pending\n\n` +
        `The web search will run in the background. ` +
        `You will be re-invoked automatically when the result is ready — your current turn ends now. ` +
        `Inform the user that you are looking up external information.`
      );
    },
    {
      name: "delegate_web_search",
      description:
        "Delegate an external information lookup to the Web Search Agent — the ONLY system agent you are " +
        "allowed to delegate to. Use this to look up library documentation, API references, current best " +
        "practices, package versions, or any information you cannot derive from your own knowledge or the " +
        "local codebase. " +
        "This is an ASYNCHRONOUS call — the web search runs in the background and your current turn will " +
        "end immediately. You will be re-invoked with the result once it completes. " +
        "Do NOT use this tool for questions the user should answer (requirements, preferences, scope) or " +
        "for information already available in the project's files. Prefer to gather external info during " +
        "planning (Phase 2) when possible, but you may call this mid-execution if it genuinely improves " +
        "task quality.",
      schema: z.object({
        request: z
          .string()
          .min(1)
          .describe(
            "A clear, specific search query or research question. Include enough context that the web " +
            "search agent can find relevant information (e.g. 'What is the latest stable version of " +
            "Sequelize that supports PostgreSQL 16?' rather than just 'Sequelize version').",
          ),
      }),
    },
  );
}
