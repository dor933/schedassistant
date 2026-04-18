import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Agent, AgentAvailableMcpServer, McpServer, LLMModel } from "@scheduling-agent/database";
import { Op } from "sequelize";

/**
 * Tool that queries the DB for available executor agents (system agents).
 *
 * The orchestrator agent calls this BEFORE delegating to understand what
 * specialists are available and pick the best match for the task at hand.
 */
export function ListSystemAgentsTool(callerAgentId: string) {
  return tool(
    async (input) => {
      const { query } = input;

      // Scope results to the caller's organization — system agents are
      // per-tenant (each org has its own set, even for shared specialists
      // like the web-search agents).
      const callerAgent = await Agent.findByPk(callerAgentId, {
        attributes: ["organizationId"],
      });
      if (!callerAgent) {
        return `Error: caller agent "${callerAgentId}" not found.`;
      }

      const where: any = {
        type: "system",
        organizationId: callerAgent.organizationId,
      };
      if (query) {
        where[Op.or] = [
          { agentName: { [Op.iLike]: `%${query}%` } },
          { slug: { [Op.iLike]: `%${query}%` } },
          { description: { [Op.iLike]: `%${query}%` } },
        ];
      }

      const agents = await Agent.findAll({
        where,
        attributes: ["id", "slug", "agentName", "description", "modelId"],
        order: [["agentName", "ASC"]],
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
      const mcpLinks = await AgentAvailableMcpServer.findAll({
        where: { agentId: { [Op.in]: agentIds }, active: true },
        attributes: ["agentId", "mcpServerId"],
      });
      const serverIds = [...new Set(mcpLinks.map((l) => l.mcpServerId))];
      const mcpServers = serverIds.length > 0
        ? await McpServer.findAll({ where: { id: { [Op.in]: serverIds } }, attributes: ["id", "name"] })
        : [];
      const serverNameById = new Map(mcpServers.map((s) => [s.id, s.name]));
      const serversByAgent = new Map<string, string[]>();
      for (const link of mcpLinks) {
        const name = serverNameById.get(link.mcpServerId);
        if (!name) continue;
        const list = serversByAgent.get(link.agentId) ?? [];
        list.push(name);
        serversByAgent.set(link.agentId, list);
      }

      // Resolve model names via modelId FK -> models table
      const modelIdsToResolve = agents
        .filter((a) => a.modelId)
        .map((a) => a.modelId as string);
      const uniqueModelIds = [...new Set(modelIdsToResolve)];
      const modelSlugById = new Map<string, string>();
      if (uniqueModelIds.length > 0) {
        const models = await LLMModel.findAll({
          where: { id: { [Op.in]: uniqueModelIds } },
          attributes: ["id", "slug"],
        });
        for (const m of models) {
          modelSlugById.set(m.id, m.slug);
        }
      }

      for (const a of agents) {
        const modelDisplay = modelSlugById.get(a.modelId ?? "") ?? "unknown";
        lines.push(`**${a.agentName}**`);
        lines.push(`  - ID: \`${a.id}\``);
        lines.push(`  - Model: ${modelDisplay}`);
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
        "Use the `delegate_to_deep_agent` tool with the **ID** (UUID) of the executor agent you want to delegate to.",
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
