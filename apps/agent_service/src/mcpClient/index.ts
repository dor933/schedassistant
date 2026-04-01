import { MultiServerMCPClient } from "@langchain/mcp-adapters";

// 1. הגדרת הקליינט שמתחבר לשרת ה-MCP
// השרת יורם אוטומטית כ-Subprocess כשהקליינט יתחיל
const mcpClient = new MultiServerMCPClient({
    mcpServers: {
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
      
      brave_search: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-brave-search"],
        // השרת הזה יורש אוטומטית את משתני הסביבה של האפליקציה שלך
      },
      
      github: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
      }
    },
  });

export default async function getMcpTools() {
 
    const tools = await mcpClient.getTools();
    return tools;
  }
