import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { McpServer, AgentMcpServer } from "@scheduling-agent/database";

const clientsCache = new Map<string, MultiServerMCPClient>();

/**
 * JSON Schema keywords not supported by all model providers (e.g. Gemini).
 * Stripping them is safe — they are validation hints, not structural.
 */
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "exclusiveMinimum",
  "exclusiveMaximum",
  "$schema",
  "examples",
  "contentMediaType",
  "contentEncoding",
]);

/** Recursively delete unsupported keys from a JSON Schema object (in-place). */
function sanitizeSchema(obj: any): any {
  if (obj == null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    for (const item of obj) sanitizeSchema(item);
    return obj;
  }
  for (const key of Object.keys(obj)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) {
      delete obj[key];
    } else {
      sanitizeSchema(obj[key]);
    }
  }
  return obj;
}

/** Sanitize every tool's schema so strict providers don't reject them. */
function sanitizeToolSchemas(tools: any[]): any[] {
  for (const tool of tools) {
    if (tool.schema) sanitizeSchema(tool.schema);
  }
  return tools;
}

/**
 * Build the environment for an MCP server subprocess.
 * Always inherits process.env so that tokens like GITHUB_PERSONAL_ACCESS_TOKEN
 * (set on the agent_service container) reach stdio-based MCP servers.
 * Custom env values from the DB are merged on top; {{VAR}} placeholders
 * are resolved from process.env.
 */
function buildMcpEnv(env: Record<string, string> | null): Record<string, string> {
  const base = { ...process.env } as Record<string, string>;
  if (!env) return base;
  for (const [key, val] of Object.entries(env)) {
    const match = val.match(/^\{\{(\w+)\}\}$/);
    base[key] = match ? (process.env[match[1]] ?? "") : val;
  }
  return base;
}

/**
 * Load MCP tools for a set of explicit server IDs.
 * Used by deep agents whose tool_config specifies which MCP servers to use.
 */
export async function getMcpToolsByServerIds(serverIds: number[], cacheKey: string) {
  if (serverIds.length === 0) return [];

  if (clientsCache.has(cacheKey)) {
    return sanitizeToolSchemas(await clientsCache.get(cacheKey)!.getTools());
  }

  const servers = await McpServer.findAll({ where: { id: serverIds } });
  if (servers.length === 0) return [];

  const mcpServers: Record<string, any> = {};
  for (const server of servers) {
    mcpServers[server.name] = {
      transport: server.transport,
      command: server.command,
      args: server.args,
      env: buildMcpEnv(server.env),
    };
  }

  const client = new MultiServerMCPClient({ mcpServers });
  clientsCache.set(cacheKey, client);
  return sanitizeToolSchemas(await client.getTools());
}

export default async function getMcpTools(agentId: string) {
  if (clientsCache.has(agentId)) {
    console.log(`Loading cached MCP tools for agent: ${agentId}`);
    return sanitizeToolSchemas(await clientsCache.get(agentId)!.getTools());
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
      env: buildMcpEnv(server.env),
    };
  }

  const client = new MultiServerMCPClient({ mcpServers });
  clientsCache.set(agentId, client);

  const tools = sanitizeToolSchemas(await client.getTools());
  return tools;
}
