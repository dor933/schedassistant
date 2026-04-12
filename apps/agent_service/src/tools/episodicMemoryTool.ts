import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type {
  AgentId,
  ProjectId,
  RepositoryId,
  UserId,
} from "@scheduling-agent/types";

import { embedText } from "../rag/embeddings";
import { insertEpisodicMemoryChunks } from "../rag/episodicMemoryChunksWriter";
import { retrieveEpisodicMemory } from "../rag/episodicRetrieval";
import { logger } from "../logger";

/**
 * Agent-invoked tool for saving a high-value, semantically self-contained
 * piece of knowledge into long-term episodic memory (vector store).
 *
 * This is the **agent-curated** counterpart to the automatic
 * `sessionSummarization` chunk writer:
 *   - sessionSummarization captures conversation-level summaries after the fact.
 *   - save_episodic_memory lets the agent explicitly mark something worth
 *     remembering *in the moment* — an architectural insight, a repo-specific
 *     gotcha, a user preference, a hard-won lesson from a tool result.
 *
 * Scoped to the caller's `agentId` so retrieval filters naturally per agent.
 * The agent may optionally attach `repositoryId` / `projectId` to narrow
 * retrieval later (useful for multi-repo orchestrators).
 */
export function SaveEpisodicMemoryTool(
  agentId: AgentId,
  userId: UserId,
  threadId: string,
) {
  return tool(
    async (input) => {
      const content = input.content.trim();
      if (!content) return "Nothing saved — content was empty.";

      try {
        await insertEpisodicMemoryChunks(
          threadId,
          userId,
          agentId,
          [content],
          embedText,
          {
            repositoryId: (input.repositoryId as RepositoryId | undefined) ?? null,
            projectId: (input.projectId as ProjectId | undefined) ?? null,
            source: "agent_save",
          },
        );

        logger.info("Agent saved episodic memory chunk", {
          threadId,
          userId,
          agentId,
          repositoryId: input.repositoryId ?? null,
          projectId: input.projectId ?? null,
          contentLength: content.length,
        });

        return "Saved to long-term memory.";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("save_episodic_memory failed", {
          threadId,
          userId,
          agentId,
          error: message,
        });
        return `Error saving memory: ${message}`;
      }
    },
    {
      name: "save_episodic_memory",
      description:
        "Saves a single high-value insight to your long-term semantic memory (vector store) so you can recall it in future conversations via embedding search. " +
        "This is the durable counterpart to `append_agent_notes`: notes are plain text shown verbatim in your system prompt, while episodic memory is retrieved semantically when relevant.\n\n" +
        "CALL this tool for things worth remembering weeks or months later:\n" +
        "  • Confirmed facts, decisions, or conclusions reached during the conversation.\n" +
        "  • User preferences, constraints, or profile details you discovered.\n" +
        "  • Domain insights, architectural observations, or non-obvious gotchas.\n" +
        "  • Lessons learned from tool results (e.g. 'repo X needs flag Y for its test runner').\n\n" +
        "Do NOT call it for:\n" +
        "  • Small talk, greetings, routine acknowledgements.\n" +
        "  • Transient context that only makes sense in this session.\n" +
        "  • Things already captured by an existing note or a prior save.\n\n" +
        "Write the `content` as 3–8 sentences of self-contained prose — include enough context that the chunk is understandable out of order, months from now. " +
        "When working on a specific repository or project, pass `repositoryId` / `projectId` so retrieval can filter correctly.",
      schema: z.object({
        content: z
          .string()
          .min(20)
          .describe(
            "Self-contained prose (3–8 sentences) capturing the insight. Include enough context to be understandable in isolation.",
          ),
        repositoryId: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Optional: UUID of the repository this insight pertains to. Scopes the memory for future retrieval.",
          ),
        projectId: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Optional: UUID of the project this insight pertains to. Scopes the memory for future retrieval.",
          ),
      }),
    },
  );
}

/**
 * Agent-invoked tool for searching long-term episodic memory (vector store).
 *
 * The system already injects auto-retrieved snippets into the context on every
 * turn (based on the user's latest message). This tool complements that by
 * letting the agent formulate its own, more targeted query — e.g. when it
 * realizes mid-conversation that it needs background on a specific repo,
 * pattern, or past decision that wasn't surfaced automatically.
 */
export function RecallEpisodicMemoryTool(agentId: AgentId) {
  return tool(
    async (input) => {
      const query = input.query.trim();
      if (!query) return "Nothing to search — query was empty.";

      try {
        const queryEmbedding = await embedText(query);
        const chunks = await retrieveEpisodicMemory(
          agentId,
          queryEmbedding,
          input.topK ?? 5,
          {
            repositoryId: input.repositoryId ?? undefined,
            projectId: input.projectId ?? undefined,
          },
        );

        if (chunks.length === 0) {
          return "No relevant episodic memories found for that query.";
        }

        return chunks.map((c, i) => `[${i + 1}] ${c}`).join("\n\n");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("recall_episodic_memory failed", {
          agentId,
          error: message,
        });
        return `Error recalling memory: ${message}`;
      }
    },
    {
      name: "recall_episodic_memory",
      description:
        "Searches your long-term semantic memory (vector store) using a custom query you provide. " +
        "Your system prompt already includes auto-retrieved episodic snippets based on the user's latest message, " +
        "but those may miss context you need. Use this tool when:\n" +
        "  • You need background on a specific repository, project, or technical topic.\n" +
        "  • The auto-retrieved snippets don't cover what you're about to work on.\n" +
        "  • You recall a past conversation or decision but need the details.\n\n" +
        "Craft a descriptive query (1–3 sentences) about the topic you need context on — " +
        "it will be embedded and matched against your stored memories via cosine similarity.",
      schema: z.object({
        query: z
          .string()
          .min(10)
          .describe(
            "Descriptive search query (1–3 sentences). Be specific about the topic, repo, or decision you want to recall.",
          ),
        topK: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Number of results to return (default 5, max 20)."),
        repositoryId: z
          .string()
          .uuid()
          .optional()
          .describe("Optional: scope search to a specific repository UUID."),
        projectId: z
          .string()
          .uuid()
          .optional()
          .describe("Optional: scope search to a specific project UUID."),
      }),
    },
  );
}
