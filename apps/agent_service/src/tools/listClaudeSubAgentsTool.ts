import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Agent, AgentAvailableMcpServer, McpServer, LLMModel } from "@scheduling-agent/database";
import { Op } from "sequelize";

/**
 * Lists the `claude_sub_agent` rows currently OWNED by the calling primary
 * (slice 17 / 19).
 *
 * IMPORTANT — this is NOT the same surface as `list_system_agents`:
 *   - `list_system_agents` returns `type: "system"` rows reachable via
 *     `delegate_to_deep_agent` / `sync_delegate_to_deep_agent` (queued
 *     deep-agent worker path).
 *   - `list_claude_sub_agents` returns `type: "claude_sub_agent"` rows
 *     reachable via the Claude Agent SDK's native `Task("<agent id>", ...)`
 *     tool and `start_epic_task` → `assignments[].id`. They run inline
 *     inside the primary's SDK session.
 *
 * The two pools are disjoint by design — see slice-17 docs in
 * `services/buildSubAgentDefinitions.service.ts` and the system-prompt
 * clarification in `graphs/basicGraph/nodes/contextBuilder.ts`. A model
 * that confuses them gets a clear error from the matching delegation
 * tool.
 *
 * Visibility: ONLY the rows owned by the calling primary
 * (`owning_primary_agent_id = callerAgentId`). Unassigned (NULL owner)
 * sub-agents stay in the admin's "available pool" and are NOT exposed —
 * the SDK runner mirrors this filter, so listing them here would tell
 * the model about agents it cannot actually invoke.
 */
export function ListClaudeSubAgentsTool(callerAgentId: string) {
  return tool(
    async (input) => {
      const { query } = input;

      const callerAgent = await Agent.findByPk(callerAgentId, {
        attributes: ["organizationId"],
      });
      if (!callerAgent) {
        return `Error: caller agent "${callerAgentId}" not found.`;
      }

      const where: any = {
        type: "claude_sub_agent",
        organizationId: callerAgent.organizationId,
        owningPrimaryAgentId: callerAgentId,
      };
      if (query) {
        where[Op.and] = [
          {
            [Op.or]: [
              { agentName: { [Op.iLike]: `%${query}%` } },
              { slug: { [Op.iLike]: `%${query}%` } },
              { description: { [Op.iLike]: `%${query}%` } },
            ],
          },
        ];
      }

      const agents = await Agent.findAll({
        where,
        attributes: ["id", "slug", "agentName", "description", "modelId"],
        order: [["agentName", "ASC"]],
      });

      if (agents.length === 0) {
        return query
          ? `No Claude sub-agents matching "${query}" are attached to you. Ask an administrator to attach one in Admin → Agents → Sub-agent assignments, then try again.`
          : "No Claude sub-agents are attached to you yet. Ask an administrator to assign one in Admin → Agents → Sub-agent assignments.";
      }

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

      const lines = [
        `Found ${agents.length} Claude sub-agent${agents.length === 1 ? "" : "s"} attached to you:`,
        "",
      ];
      for (const a of agents) {
        const sdkSlug = a.slug ?? `csa_${a.id.replace(/-/g, "_")}`;
        const displayName = a.agentName ?? sdkSlug;
        const modelDisplay = modelSlugById.get(a.modelId ?? "") ?? "inherited";
        lines.push(`**${displayName}**`);
        lines.push(
          `  - Id for \`start_epic_task\` / \`Task\`: \`${a.id}\``,
        );
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
        'Invoke a sub-agent via `Task("<sub-agent id>", "<task description>")` — this runs inline in your turn and returns the result synchronously. ' +
        "Use the same id in `start_epic_task` → `assignments[].id`. " +
        "Do NOT pass these ids to `delegate_to_deep_agent` (different pool — that's for system agents).",
      );

      return lines.join("\n");
    },
    {
      name: "list_claude_sub_agents",
      description:
        "List the Claude sub-agents currently attached to YOU (your owned `claude_sub_agent` rows). " +
        "Each entry is identified by **database id** for `start_epic_task` and `Task` — call this BEFORE " +
        "invoking those tools to discover which sub-agents exist. **Distinct from `list_system_agents`**: that lists " +
        "executors reachable via `delegate_to_deep_agent` (different pool, different runtime).",
      schema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            "Optional keyword to filter by name, slug, or description. Leave empty to list everything attached to you.",
          ),
      }),
    },
  );
}
