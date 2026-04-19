import { tool } from "@langchain/core/tools";
import { TavilySearchAPIWrapper } from "@langchain/tavily";
import { z } from "zod";
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
  const wrapper = new TavilySearchAPIWrapper({});
  return tool(
    async ({ query, maxResults }) => {
      const results = await wrapper.invoke({
        query,
        ...(typeof maxResults === "number" ? { maxResults } : {}),
      });
      return typeof results === "string"
        ? results
        : JSON.stringify(results, null, 2);
    },
    {
      name: "tavily_search",
      description:
        "Search the web for up-to-date information, articles, documentation, and answers using Tavily. " +
        "Returns ranked results with URLs and extracted snippets.",
      schema: z.object({
        query: z.string().min(1).describe("The search query."),
        maxResults: z
          .number()
          .int()
          .positive()
          .max(20)
          .optional()
          .describe("Maximum number of results to return (1-20). Defaults to Tavily's own default."),
      }),
    },
  );
}
