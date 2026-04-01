import { MultiServerMCPClient } from "@langchain/mcp-adapters";


const ALL_SERVERS_CONFIG = {
  filesystem: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", process.env.DATA_DIR || "/app/data"],
  },
  bash: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-bash"],
  },
  fetch: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
  },

  github: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
  }
};

const AGENT_PERMISSIONS: Record<string, (keyof typeof ALL_SERVERS_CONFIG)[]> = {
  "general_agent": ["filesystem", "bash", "github", "fetch"], 
};

const clientsCache = new Map<string, MultiServerMCPClient>();


export default async function getMcpTools(agentName: string = "general_agent") {
  const requiredServers = AGENT_PERMISSIONS[agentName];
  if (!requiredServers) {
    console.warn(`No MCP servers defined for agent: ${agentName}`);
    return []; // 
  }

  if (clientsCache.has(agentName)) {
    console.log(`Loading cached MCP tools for agent: ${agentName}`);
    return await clientsCache.get(agentName)!.getTools();
  }

  console.log(`Initializing new MCP client for agent: ${agentName}...`);

  const agentSpecificConfig: any = {};
  for (const serverName of requiredServers) {
    agentSpecificConfig[serverName] = ALL_SERVERS_CONFIG[serverName];
  }

  const client = new MultiServerMCPClient({
    mcpServers: agentSpecificConfig,
  });

  clientsCache.set(agentName, client);

  const tools = await client.getTools();
  return tools;
}