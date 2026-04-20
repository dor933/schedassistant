import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  EpisodicMemory,
  Roundtable,
  Thread,
} from "@scheduling-agent/database";
import type { AgentId } from "@scheduling-agent/types";

import { logger } from "../logger";

/**
 * Agent-invoked tool for fetching the canonical summary of a past thread or
 * roundtable when the auto-retrieved episodic memory chunks don't provide
 * enough context.
 *
 * Typical flow:
 *   1. Agent recalls episodic memory (automatic or via `recall_episodic_memory`).
 *   2. A chunk hints at a past session/roundtable but lacks detail.
 *   3. Agent calls `get_thread_summary` with that thread_id to pull the full,
 *      human-readable summary written when the session or roundtable ended.
 *
 * **Access control:** the tool only returns a summary when the given thread_id
 * actually appears in THIS agent's `episodic_memory` rows. That guarantees the
 * agent can only read summaries for conversations it was part of, even though
 * the `threads` and `roundtables` tables have no direct agent FK.
 */
export function GetThreadSummaryTool(agentId: AgentId | null) {
  return tool(
    async (input) => {
      const threadId = input.threadId?.trim();
      if (!threadId) return "No thread_id provided.";
      if (!agentId) {
        return "No agent context — cannot look up summaries.";
      }

      try {
        // 1. Gate: only return summaries for threads this agent has memories in.
        const memoryRow = await EpisodicMemory.findOne({
          where: { threadId, agentId },
          attributes: ["id"],
        });
        if (!memoryRow) {
          return `No summary available — thread ${threadId} is not in your episodic memory.`;
        }

        // 2. Pull both summaries in parallel; either may be null.
        const [thread, roundtable] = await Promise.all([
          Thread.findByPk(threadId, {
            attributes: ["id", "summary", "summarizedAt"],
          }),
          Roundtable.findOne({
            where: { threadId },
            attributes: ["id", "topic", "summary", "summaryGeneratedAt"],
          }),
        ]);

        const parts: string[] = [];

        if (roundtable?.summary) {
          const when = roundtable.summaryGeneratedAt
            ? ` (generated ${roundtable.summaryGeneratedAt.toISOString()})`
            : "";
          parts.push(
            `## Roundtable summary — "${roundtable.topic}"${when}\n\n${roundtable.summary}`,
          );
        }

        if (thread?.summary?.text) {
          const s = thread.summary;
          const when = thread.summarizedAt
            ? ` (summarized ${thread.summarizedAt.toISOString()})`
            : s.createdAt
              ? ` (created ${s.createdAt})`
              : "";
          const meta: string[] = [];
          if (typeof s.messageCount === "number")
            meta.push(`${s.messageCount} messages`);
          if (typeof s.tokenCount === "number")
            meta.push(`${s.tokenCount} tokens`);
          if (s.confidence) meta.push(`confidence: ${s.confidence}`);
          const metaLine = meta.length > 0 ? `\n\n_${meta.join(" · ")}_` : "";
          parts.push(
            `## Session summary${when}\n\n${s.text}${metaLine}`,
          );
        }

        if (parts.length === 0) {
          return `Thread ${threadId} exists in your memory but has no saved summary yet.`;
        }

        return parts.join("\n\n---\n\n");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("get_thread_summary failed", {
          agentId,
          threadId,
          error: message,
        });
        return `Error loading thread summary: ${message}`;
      }
    },
    {
      name: "get_thread_summary",
      description:
        "Loads the full summary of a past conversation or roundtable by thread_id. " +
        "Use this as a follow-up when `recall_episodic_memory` returned a chunk that references a " +
        "past session or roundtable but doesn't give you enough detail to act on.\n\n" +
        "Episodic memory chunks include their originating `thread_id` in metadata. If a retrieved " +
        "chunk isn't self-sufficient — e.g. it mentions 'the Q2 roadmap review' but lacks the " +
        "conclusions — call this tool with the chunk's thread_id to pull the full saved summary.\n\n" +
        "Returns whichever are available: the session-level summary (from `threads.summary`) and, " +
        "if the thread was a roundtable, the final roundtable summary as well. " +
        "Returns nothing useful if the thread has no saved summary or wasn't one of your conversations.",
      schema: z.object({
        threadId: z
          .string()
          .min(1)
          .describe(
            "The thread_id to look up. Obtain this from the `threadId` field in episodic memory metadata.",
          ),
      }),
    },
  );
}
