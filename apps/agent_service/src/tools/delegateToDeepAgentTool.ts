import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Agent, DeepAgentDelegation, Organization } from "@scheduling-agent/database";
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
 * `callerThreadId` is forwarded so the executor can scope its filesystem
 * writes to the caller's per-thread session workspace
 * (`<callerWorkspacePath>/threads/<callerThreadId>/`) — see
 * apps/agent_service/src/workspace/sessionWorkspace.ts.
 */
export function DelegateToDeepAgentTool(
  callerAgentId: string,
  userId: number,
  groupId: string | null,
  singleChatId: string | null,
  callerThreadId: string | null,
) {
  return tool(
    async (input) => {
      const { systemAgentId, request } = input;

      const callerAgent = await Agent.findByPk(callerAgentId, {
        attributes: ["id", "organizationId"],
      });
      if (!callerAgent) {
        return `Error: caller agent "${callerAgentId}" not found.`;
      }

      const executorAgent = await Agent.findOne({
        where: {
          id: systemAgentId,
          type: "system",
          organizationId: callerAgent.organizationId,
        },
      });
      if (!executorAgent) {
        return (
          `Error: system agent with id "${systemAgentId}" not found in this organization. ` +
          `Use list_system_agents to see available executor agents.`
        );
      }

      // Ownership gate: a system agent with a non-NULL owning_primary_agent_id
      // is private to that owner. The caller can only delegate to it if they
      // *are* the owner — otherwise the executor is out of scope. NULL
      // owners are shared (org-wide) and pass this gate trivially.
      if (
        executorAgent.owningPrimaryAgentId &&
        executorAgent.owningPrimaryAgentId !== callerAgentId
      ) {
        const ownerLabel = executorAgent.owningPrimaryAgentId;
        const execLabel =
          executorAgent.agentName || executorAgent.definition || executorAgent.id;
        return (
          `Error: executor "${execLabel}" is a private specialist of primary agent ${ownerLabel}, ` +
          `not yours. Pick a different executor (call list_system_agents to see only the agents ` +
          `you are allowed to delegate to) or hand the request off to that primary instead.`
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
        request,
        callerAgentId,
        userId,
        groupId,
        singleChatId,
        callerThreadId,
      });

      await linkDelegationToConsultation(callerAgentId, delegation.id);

      const label = executorAgent.agentName || executorAgent.definition || executorAgent.id;

      logger.info("DelegateToDeepAgent: job enqueued", {
        delegationId: delegation.id,
        callerAgentId,
        executorAgentId: executorAgent.id,
        requestLen: request.length,
      });

      return (
        `Executor agent task delegated successfully.\n` +
        `- Delegation ID: ${delegation.id}\n` +
        `- Executor Agent: ${label} (${executorAgent.id})\n` +
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
        systemAgentId: z
          .string()
          .uuid()
          .describe(
            "The UUID of the system agent to delegate to. Use list_system_agents first to discover available agents and their IDs.",
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
 * Resolves the target web-search system agent by looking up the caller
 * agent's organization and following `organizations.web_search_agent_id`.
 * Each org owns its own Gemini + Tavily web-search agents; the admin
 * chooses which one is active per org.
 */
export function DelegateWebSearchTool(
  callerAgentId: string,
  userId: number,
  groupId: string | null,
  singleChatId: string | null,
  callerThreadId: string | null,
) {
  return tool(
    async (input) => {
      const { request } = input;

      const callerAgent = await Agent.findByPk(callerAgentId, {
        attributes: ["id", "organizationId"],
      });
      if (!callerAgent) {
        return `Error: caller agent "${callerAgentId}" not found.`;
      }

      const org = await Organization.findByPk(callerAgent.organizationId, {
        attributes: ["id", "webSearchAgentId"],
      });
      if (!org?.webSearchAgentId) {
        return (
          `Error: no web-search agent is configured for this organization. ` +
          `Ask an administrator to pick Gemini or Tavily in the admin panel.`
        );
      }

      const executorAgent = await Agent.findOne({
        where: {
          id: org.webSearchAgentId,
          organizationId: org.id,
          type: "system",
        },
      });
      if (!executorAgent) {
        return (
          `Error: the organization's configured web-search agent (${org.webSearchAgentId}) ` +
          `could not be loaded. Ask an administrator to re-select one in the admin panel.`
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
        request,
        callerAgentId,
        userId,
        groupId,
        singleChatId,
        callerThreadId,
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
        `- Target: Web Search Agent (${executorAgent.id})\n` +
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
