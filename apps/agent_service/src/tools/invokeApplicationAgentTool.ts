import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Agent } from "@scheduling-agent/database";
import { getApplicationGraph } from "../deps";
import { invokeApplicationAgent } from "./application.service";
import { logger } from "../logger";

/**
 * Synchronous tool that lets a primary agent invoke an application agent
 * in-process.
 *
 * Application agents are stateless deep-agent runs — each call is one-shot,
 * uses its own MemorySaver thread, and returns the final assistant text.
 * Pass the calling user's id so the application agent's downstream
 * consultations (if any) attribute back to the right user.
 *
 * The target agent is verified to exist, belong to the caller's organization,
 * and be of type 'application' before invocation. Cross-org and wrong-type
 * targets are rejected with a clear error.
 */
export function InvokeApplicationAgentTool(callerAgentId: string, userId: number) {
  return tool(
    async (input) => {
      const { applicationAgentId, request } = input;

      const callerAgent = await Agent.findByPk(callerAgentId, {
        attributes: ["id", "organizationId", "agentName", "definition"],
      });
      if (!callerAgent) {
        return `Error: caller agent "${callerAgentId}" not found.`;
      }

      const target = await Agent.findOne({
        where: {
          id: applicationAgentId,
          organizationId: callerAgent.organizationId,
        },
        attributes: ["id", "type", "agentName", "description"],
      });

      if (!target) {
        return (
          `Error: application agent "${applicationAgentId}" not found in this organization. ` +
          `The available application agents are listed in your system prompt.`
        );
      }
      if (target.type !== "application") {
        return (
          `Error: agent "${applicationAgentId}" has type "${target.type}", expected "application". ` +
          `Use \`consult_agent\` for primary agents or \`delegate_to_deep_agent\` for system agents.`
        );
      }

      const label = target.agentName || target.id;
      const callerLabel =
        callerAgent.agentName?.trim() ||
        callerAgent.definition?.trim() ||
        callerAgent.id;

      // Prefix the request so the application agent can tell that the
      // message originated from a primary delegation. Mirrors how
      // `consult_agent` labels cross-agent requests.
      const prefixedRequest = `[Delegated from primary agent "${callerLabel}"]\n\n${request}`;

      logger.info("InvokeApplicationAgent: starting", {
        callerAgentId,
        applicationAgentId,
        userId,
        requestLen: request.length,
      });

      try {
        const graph = getApplicationGraph();
        const result = await invokeApplicationAgent(graph, {
          agentId: applicationAgentId,
          input: prefixedRequest,
          userId,
        });

        if (!result.ok) {
          logger.warn("InvokeApplicationAgent: invocation failed", {
            callerAgentId,
            applicationAgentId,
            status: result.status,
            error: result.error,
          });
          return `Error invoking application agent "${label}": ${result.error}`;
        }

        logger.info("InvokeApplicationAgent: completed", {
          callerAgentId,
          applicationAgentId,
          outputLen: result.output.length,
        });

        return result.output;
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        logger.error("InvokeApplicationAgent: unexpected error", {
          callerAgentId,
          applicationAgentId,
          error: msg,
        });
        return `Error invoking application agent "${label}": ${msg}`;
      }
    },
    {
      name: "invoke_application_agent",
      description:
        "Synchronously invoke an application agent — a stateless REST-style specialist " +
        "that runs once on your behalf and returns its final answer. Application agents " +
        "have their own dedicated system prompt and tool set (e.g. database access). " +
        "Use this when the user's question maps cleanly to a known application agent's " +
        "purpose (their goals are listed in your system prompt under 'Available application " +
        "agents'). Each call is independent — the application agent has no memory of prior " +
        "calls. For consulting peer primary agents use `consult_agent`; for delegating " +
        "long-running work to system agents use `delegate_to_deep_agent`.",
      schema: z.object({
        applicationAgentId: z
          .string()
          .uuid()
          .describe(
            "The UUID of the application agent to invoke. Pick from the list of " +
            "application agents shown in your system prompt.",
          ),
        request: z
          .string()
          .min(1)
          .describe(
            "The full request to send to the application agent. Include all relevant " +
            "context — the application agent has no memory of prior turns.",
          ),
      }),
    },
  );
}
