import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { SystemAgent, SystemAgentMcpServer, McpServer } from "@scheduling-agent/database";
import { Op } from "sequelize";

/**
 * Tool that queries the DB for available executor agents (system agents).
 *
 * The orchestrator agent calls this BEFORE delegating to understand what
 * specialists are available and pick the best match for the task at hand.
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
        attributes: ["id", "slug", "name", "description", "modelSlug"],
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

      // Batch-load MCP server names for all returned system agents
      const agentIds = agents.map((a) => a.id);
      const mcpLinks = await SystemAgentMcpServer.findAll({
        where: { systemAgentId: { [Op.in]: agentIds } },
        attributes: ["systemAgentId", "mcpServerId"],
      });
      const serverIds = [...new Set(mcpLinks.map((l) => l.mcpServerId))];
      const mcpServers = serverIds.length > 0
        ? await McpServer.findAll({ where: { id: { [Op.in]: serverIds } }, attributes: ["id", "name"] })
        : [];
      const serverNameById = new Map(mcpServers.map((s) => [s.id, s.name]));
      const serversByAgent = new Map<number, string[]>();
      for (const link of mcpLinks) {
        const name = serverNameById.get(link.mcpServerId);
        if (!name) continue;
        const list = serversByAgent.get(link.systemAgentId) ?? [];
        list.push(name);
        serversByAgent.set(link.systemAgentId, list);
      }

      for (const a of agents) {
        lines.push(`**${a.name}**`);
        lines.push(`  - Slug: \`${a.slug}\``);
        lines.push(`  - Model: ${a.modelSlug}`);
        if (a.description) {
          lines.push(`  - Description: ${a.description}`);
        }
        const mcpNames = serversByAgent.get(a.id);
        if (mcpNames && mcpNames.length > 0) {
          lines.push(`  - MCP tools: ${mcpNames.join(", ")}`);
        }
        lines.push("");
      }

      lines.push(
        "Use the `delegate_to_deep_agent` tool with the slug of the executor agent you want to delegate to.",
      );

      return lines.join("\n");
    },
    {
      name: "list_system_agents",
      description:
        "Search and list available executor agents (specialists) that you can delegate tasks to. " +
        "Call this BEFORE using `delegate_to_deep_agent` to discover which executor agents exist and " +
        "find the best match for the task you need to delegate. You can optionally filter by a keyword to narrow results.",
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
