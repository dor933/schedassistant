import { AgentAvailableTool, Tool } from "@scheduling-agent/database";
import { Op } from "sequelize";

/**
 * Legacy minimal-default tool set, retained for callers that explicitly
 * opt in via `{ applyDefaults: true }`. These three tools used to be
 * implicitly granted to every agent that had zero `agent_available_tools`
 * rows; that fallback is now OFF by default to enforce
 * "no marking → no tool" — admins must tick each tool explicitly.
 */
const DEFAULT_TOOL_SLUGS = new Set([
  "consult_agent",
  "list_agents",
  "list_system_agents",
]);

/**
 * Returns the set of active tool slugs assigned to the given agent via
 * `agent_available_tools`. **No implicit defaults**: if the agent has no
 * row at all, the returned set is empty — admins must explicitly tick
 * each tool they want the agent to have. The legacy 3-tool fallback can
 * still be opted into per-call with `{ applyDefaults: true }` for the
 * rare caller that genuinely needs it (none today; left for backwards
 * compat).
 *
 * Agents must be explicitly granted access to ALL tools they should be
 * able to call (`consult_agent`, `list_agents`, `list_system_agents`,
 * `delegate_to_deep_agent`, `query_database`, etc.) via
 * `agent_available_tools` rows.
 */
export async function loadActiveToolSlugs(
  agentId: string | null | undefined,
  options: { applyDefaults?: boolean } = {},
): Promise<Set<string>> {
  const applyDefaults = options.applyDefaults ?? false;
  const emptyFallback = applyDefaults ? DEFAULT_TOOL_SLUGS : new Set<string>();

  if (!agentId) return emptyFallback;

  const links = await AgentAvailableTool.findAll({
    where: { agentId },
    attributes: ["toolId", "active"],
  });

  if (links.length === 0) return emptyFallback;

  const activeToolIds = links.filter((l) => l.active).map((l) => l.toolId);
  if (activeToolIds.length === 0) return new Set();

  const tools = await Tool.findAll({
    where: { id: { [Op.in]: activeToolIds } },
    attributes: ["slug"],
  });

  return new Set(tools.map((t) => t.slug));
}
