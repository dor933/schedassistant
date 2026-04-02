import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { SystemAgent } from "@scheduling-agent/database";
import { Op } from "sequelize";

/**
 * Tool that queries the DB for available system agents (deep agents).
 *
 * The agent calls this BEFORE delegating to understand what specialists
 * are available and pick the best match for the task at hand.
 */
export function ListSystemAgentsTool() {
  return tool(
    async (input) => {
      const { query } = input;

      const where: any = {};
      if (query) {
        // Search across name, slug, and description
        where[Op.or] = [
          { name: { [Op.iLike]: `%${query}%` } },
          { slug: { [Op.iLike]: `%${query}%` } },
          { description: { [Op.iLike]: `%${query}%` } },
        ];
      }

      const agents = await SystemAgent.findAll({
        where,
        attributes: ["slug", "name", "description", "modelSlug"],
        order: [["name", "ASC"]],
      });

      if (agents.length === 0) {
        return query
          ? `No system agents found matching "${query}". Try a broader search or call without a query to see all available agents.`
          : "No system agents are configured. Ask an administrator to create system agents in the database.";
      }

      const lines = [
        `Found ${agents.length} system agent${agents.length === 1 ? "" : "s"}:`,
        "",
      ];

      for (const a of agents) {
        lines.push(`**${a.name}**`);
        lines.push(`  - Slug: \`${a.slug}\``);
        lines.push(`  - Model: ${a.modelSlug}`);
        if (a.description) {
          lines.push(`  - Description: ${a.description}`);
        }
        lines.push("");
      }

      lines.push(
        "Use the `delegate_to_deep_agent` tool with the slug of the agent you want to delegate to.",
      );

      return lines.join("\n");
    },
    {
      name: "list_system_agents",
      description:
        "Search and list available specialist deep agents that you can delegate complex tasks to. " +
        "Call this BEFORE using `delegate_to_deep_agent` to discover which specialists exist and " +
        "find the best match for your task. You can optionally filter by a keyword to narrow results.",
      schema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            "Optional keyword to filter agents by name, slug, or description. " +
            'E.g. "stock", "research", "pattern". Leave empty to list all available agents.',
          ),
      }),
    },
  );
}
