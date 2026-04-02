import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { McpServer, AgentMcpServer } from "@scheduling-agent/database";

const clientsCache = new Map<string, MultiServerMCPClient>();

/**
 * Resolve env placeholders like `{{VAR}}` with actual process.env values.
 */
function resolveEnv(env: Record<string, string> | null): Record<string, string> | undefined {
  if (!env) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, val] of Object.entries(env)) {
    const match = val.match(/^\{\{(\w+)\}\}$/);
    resolved[key] = match ? (process.env[match[1]] ?? "") : val;
  }
  return { ...resolved, ...process.env as Record<string, string> };
}

/**
 * Load MCP tools for a set of explicit server IDs.
 * Used by deep agents whose tool_config specifies which MCP servers to use.
 */
export async function getMcpToolsByServerIds(serverIds: number[], cacheKey: string) {
  if (serverIds.length === 0) return [];

  if (clientsCache.has(cacheKey)) {
    return await clientsCache.get(cacheKey)!.getTools();
  }

  const servers = await McpServer.findAll({ where: { id: serverIds } });
  if (servers.length === 0) return [];

  const mcpServers: Record<string, any> = {};
  for (const server of servers) {
    mcpServers[server.name] = {
      transport: server.transport,
      command: server.command,
      args: server.args,
      ...(server.env ? { env: resolveEnv(server.env) } : {}),
    };
  }

  const client = new MultiServerMCPClient({ mcpServers });
  clientsCache.set(cacheKey, client);
  return await client.getTools();
}

export default async function getMcpTools(agentId: string) {
  if (clientsCache.has(agentId)) {
    console.log(`Loading cached MCP tools for agent: ${agentId}`);
    return await clientsCache.get(agentId)!.getTools();
  }

  // Fetch the MCP servers assigned to this agent
  const links = await AgentMcpServer.findAll({
    where: { agentId },
    attributes: ["mcpServerId"],
  });

  if (links.length === 0) {
    console.warn(`No MCP servers assigned to agent: ${agentId}`);
    return [];
  }

  const serverIds = links.map((l) => l.mcpServerId);
  const servers = await McpServer.findAll({
    where: { id: serverIds },
  });

  if (servers.length === 0) {
    console.warn(`No MCP server records found for agent: ${agentId}`);
    return [];
  }

  console.log(
    `Initializing MCP client for agent ${agentId} with servers: ${servers.map((s) => s.name).join(", ")}`,
  );

  const mcpServers: Record<string, any> = {};
  for (const server of servers) {
    mcpServers[server.name] = {
      transport: server.transport,
      command: server.command,
      args: server.args,
      ...(server.env ? { env: resolveEnv(server.env) } : {}),
    };
  }

  const client = new MultiServerMCPClient({ mcpServers });
  clientsCache.set(agentId, client);

  const tools = await client.getTools();
  return tools;
}
