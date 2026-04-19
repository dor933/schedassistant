import { TavilySearch } from "@langchain/tavily";
import { logger } from "../logger";

/**
 * Tavily-backed web search tool.
 *
 * Replaces the legacy `brave-search` MCP server as the non-Gemini option for
 * the dedicated web-search system agent. Unlike Brave — which runs as an MCP
 * subprocess — Tavily is a native LangChain tool, so it is injected directly
 * into the deep agent's tool array by the worker when the system agent's
 * toolConfig has `useTavily: true`.
 *
 * Requires `TAVILY_API_KEY` in the agent_service environment.
 */
export function TavilySearchTool() {
  if (!process.env.TAVILY_API_KEY) {
    logger.warn("TavilySearchTool: TAVILY_API_KEY is not set — calls will fail");
  }
  return new TavilySearch({ maxResults: 5 });
}
