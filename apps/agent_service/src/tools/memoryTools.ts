import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { AgentId, UserId } from "@scheduling-agent/types";

import {
  saveEpisodicMemory,
  searchEpisodicMemory,
} from "../rag/episodicMemory";

/**
 * `save_memory` — let the model persist a chunk of text into the agent's
 * long-term vector store. Use when something is worth remembering across
 * future conversations (facts, preferences, decisions, etc.).
 */
export function SaveMemoryTool(agentId: AgentId, userId: UserId | null) {
  return tool(
    async (input) => {
      const { content, tags } = input;
      const metadata =
        tags && tags.length > 0 ? ({ tags } as Record<string, unknown>) : null;
      const id = await saveEpisodicMemory({
        agentId,
        userId,
        content,
        metadata,
      });
      if (!id) {
        return "Failed to save memory (empty content or embedding error).";
      }
      return `Saved memory (id: ${id}).`;
    },
    {
      name: "save_memory",
      description:
        "Save an important piece of information to your long-term memory (vector store). " +
        "Use this when the user shares a fact, preference, decision, or context that you want to remember " +
        "across future conversations. Keep each memory self-contained — future you should be able to " +
        "understand it without additional context.",
      schema: z.object({
        content: z
          .string()
          .min(1)
          .describe(
            "The text to remember. Should be a self-contained, meaningful statement (one fact or a short paragraph).",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Optional tags to help you find this memory later (e.g. ['preferences', 'work']).",
          ),
      }),
    },
  );
}

/**
 * `search_memory` — semantic search over the agent's long-term vector store.
 *
 * Results are automatically scoped to the current user (plus any agent-wide
 * memories with `user_id IS NULL`) so one user can never retrieve another
 * user's private memories through the same agent.
 */
export function SearchMemoryTool(agentId: AgentId, userId: UserId | null) {
  return tool(
    async (input) => {
      const { query, top_k } = input;
      const results = await searchEpisodicMemory({
        agentId,
        userId,
        query,
        topK: top_k,
      });
      if (results.length === 0) {
        return `No relevant memories found for "${query}".`;
      }
      const lines: string[] = [
        `Found ${results.length} memor${results.length === 1 ? "y" : "ies"} for "${query}":`,
        "",
      ];
      for (const r of results) {
        const savedAt =
          r.createdAt instanceof Date
            ? r.createdAt.toISOString()
            : String(r.createdAt);
        lines.push(`- [${savedAt}] (distance ${r.distance.toFixed(3)}) ${r.content}`);
        if (r.metadata && Object.keys(r.metadata).length > 0) {
          lines.push(`  metadata: ${JSON.stringify(r.metadata)}`);
        }
      }
      return lines.join("\n");
    },
    {
      name: "search_memory",
      description:
        "Search your long-term memory (vector store) for information you saved previously. " +
        "Use this when the user asks about something you might remember, or when you need context " +
        "that could have been stored in an earlier conversation. Returns the most semantically similar memories.",
      schema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            "A natural-language query describing the information you're looking for.",
          ),
        top_k: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("How many memories to return (default 5, max 25)."),
      }),
    },
  );
}
