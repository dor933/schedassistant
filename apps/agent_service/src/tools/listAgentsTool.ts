import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Agent } from "@scheduling-agent/database";
import { Op } from "sequelize";

/**
 * Tool that queries the DB for peer agents (the `agents` table).
 *
 * These are fellow orchestrator agents that can be consulted via `consult_agent`.
 * This is distinct from `list_system_agents`, which lists executor/specialist
 * agents used for async delegation via `delegate_to_deep_agent`.
 */
export function ListAgentsTool(callerAgentId: string) {
  return tool(
    async (input) => {
      const { query } = input;

      const where: any = {
        // Exclude the calling agent from results
        id: { [Op.ne]: callerAgentId },
      };
      if (query) {
        where[Op.and] = [
          where.id ? { id: where.id } : {},
          {
            [Op.or]: [
              { agentName: { [Op.iLike]: `%${query}%` } },
              { definition: { [Op.iLike]: `%${query}%` } },
            ],
          },
        ];
        // Remove the top-level id so it doesn't conflict with [Op.and]
        delete where.id;
        (where[Op.and] as any[])[0] = { id: { [Op.ne]: callerAgentId } };
      }

      const agents = await Agent.findAll({
        where,
        attributes: ["id", "agentName", "definition"],
        order: [["createdAt", "ASC"]],
      });

      if (agents.length === 0) {
        return query
          ? `No peer agents found matching "${query}". Try a broader search or call without a query to see all.`
          : "No other agents are configured in the system.";
      }

      const lines = [
        `Found ${agents.length} peer agent${agents.length === 1 ? "" : "s"} you can consult:`,
        "",
      ];

      for (const a of agents) {
        const name = a.agentName || a.definition || "(unnamed)";
        lines.push(`**${name}**`);
        lines.push(`  - ID: \`${a.id}\``);
        if (a.definition && a.agentName) {
          lines.push(`  - Role: ${a.definition}`);
        }
        lines.push("");
      }

      lines.push(
        "Use the `consult_agent` tool with the agent's ID to send them a message and get a response.",
      );

      return lines.join("\n");
    },
    {
      name: "list_agents",
      description:
        "List peer agents (fellow orchestrators) that you can talk to and consult with. " +
        "These are agents like you (NOT executor/system agents) that you can interact with using `consult_agent`. " +
        "Use this to discover which peer agents exist and get their IDs before consulting them. " +
        "This is different from `list_system_agents` which lists executor agents for async task delegation.",
      schema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            "Optional keyword to filter agents by name or role. " +
            'E.g. "data engineer", "project manager". Leave empty to list all peer agents.',
          ),
      }),
    },
  );
}
