import { AgentAvailableTool, Tool } from "@scheduling-agent/database";
import { Op } from "sequelize";

/**
 * Returns the set of active tool slugs assigned to the given agent via
 * `agent_available_tools`. If the agent has no assignments at all, returns
 * `null` — callers should treat `null` as "give all tools" for backward
 * compatibility with agents that existed before the tools table was populated.
 */
export async function loadActiveToolSlugs(
  agentId: string | null | undefined,
): Promise<Set<string> | null> {
  if (!agentId) return null;

  const links = await AgentAvailableTool.findAll({
    where: { agentId },
    attributes: ["toolId", "active"],
  });

  if (links.length === 0) return null;

  const activeToolIds = links.filter((l) => l.active).map((l) => l.toolId);
  if (activeToolIds.length === 0) return new Set();

  const tools = await Tool.findAll({
    where: { id: { [Op.in]: activeToolIds } },
    attributes: ["slug"],
  });

  return new Set(tools.map((t) => t.slug));
}
