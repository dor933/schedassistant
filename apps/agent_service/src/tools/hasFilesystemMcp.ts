import { AgentAvailableMcpServer, McpServer } from "@scheduling-agent/database";

/**
 * Canonical name (see `mcp_servers` seed) of the filesystem MCP server that
 * exposes `read_text_file` / `write_file` / `edit_file` / `list_directory` /
 * `search_files` etc. under `/app/data`. Used to decide whether an agent
 * should be shown the filesystem-backed workspace + library skills.
 */
export const FILESYSTEM_MCP_NAME = "filesystem";

/**
 * Returns true when the agent has the filesystem MCP server attached and the
 * link is active. Agents without it should not see the workspace/library
 * skills — they have no way to act on those instructions anyway.
 */
export async function hasFilesystemMcp(agentId: string | null | undefined): Promise<boolean> {
  if (!agentId) return false;
  const server = await McpServer.findOne({
    where: { name: FILESYSTEM_MCP_NAME },
    attributes: ["id"],
  });
  if (!server) return false;
  const link = await AgentAvailableMcpServer.findOne({
    where: { agentId, mcpServerId: server.id, active: true },
    attributes: ["id"],
  });
  return !!link;
}
