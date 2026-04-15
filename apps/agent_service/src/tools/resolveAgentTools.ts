import { AgentAvailableTool, Tool } from "@scheduling-agent/database";
import { Op } from "sequelize";

/**
 * Minimal default tool set for agents that have no explicit `agent_available_tools`
 * rows. These are safe, low-privilege tools that any agent can use without risk.
 *
 * To grant an agent access to powerful tools (delegate_to_deep_agent, query_database,
 * delegate_to_epic_orchestrator, etc.), explicitly add rows to `agent_available_tools`.
 */
const DEFAULT_TOOL_SLUGS = new Set([
  "consult_agent",
  "list_agents",
  "list_system_agents",
]);

/**
 * Returns the set of active tool slugs assigned to the given agent via
 * `agent_available_tools`. If the agent has no assignments at all, returns
 * the minimal default set (safe tools only).
 *
 * Agents must be explicitly granted access to powerful tools like
 * `delegate_to_deep_agent`, `delegate_to_epic_orchestrator`, or `query_database`
 * via the `agent_available_tools` table.
 */
export async function loadActiveToolSlugs(
  agentId: string | null | undefined,
): Promise<Set<string>> {
  if (!agentId) return DEFAULT_TOOL_SLUGS;

  const links = await AgentAvailableTool.findAll({
    where: { agentId },
    attributes: ["toolId", "active"],
  });

  if (links.length === 0) return DEFAULT_TOOL_SLUGS;

  const activeToolIds = links.filter((l) => l.active).map((l) => l.toolId);
  if (activeToolIds.length === 0) return new Set();

  const tools = await Tool.findAll({
    where: { id: { [Op.in]: activeToolIds } },
    attributes: ["slug"],
  });

  return new Set(tools.map((t) => t.slug));
}
