import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  Roundtable,
  Thread,
} from "@scheduling-agent/database";
import type { AgentId, SessionFileEntry } from "@scheduling-agent/types";

import { logger } from "../logger";
import { agentMayAccessThread } from "../utils/agentThreadAccess";

/**
 * Renders the per-thread session file manifest as a Markdown section so the
 * agent can pick a candidate file (and its path) without making a separate
 * vector search. Returns "" when the thread has no file manifest.
 */
function formatFilesSection(
  files: SessionFileEntry[] | undefined,
  threadId: string,
): string {
  if (!files || files.length === 0) return "";
  const lines: string[] = [];
  lines.push("");
  lines.push("");
  lines.push("### Files written during this session");
  lines.push(
    `Use \`read_session_file\` with \`threadId="${threadId}"\` and the path below ` +
      "to read any of these.",
  );
  lines.push("");
  for (const f of files) {
    const meta = `${f.bytes} bytes, updated ${f.updatedAt}`;
    const summary = f.summary?.trim();
    if (summary) {
      lines.push(`- \`${f.path}\` — ${summary}  _(${meta})_`);
    } else {
      lines.push(`- \`${f.path}\`  _(${meta})_`);
    }
  }
  return lines.join("\n");
}

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
 * **Access control:** delegated to `agentMayAccessThread()` — passes when the
 * agent owns the thread directly (`threads.agent_id == agentId`, single-chat
 * or group case) or when the thread is a roundtable the agent participated in
 * (`roundtable_agents` membership). This works the moment a thread is created,
 * unlike the old "must have an episodic_memory row" proxy which only became
 * true after summarization had embedded chunks.
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
        // 1. Gate via direct schema relationship (Thread.agentId or
        //    roundtable_agents membership for multi-agent threads).
        if (!(await agentMayAccessThread(agentId, threadId))) {
          return `No summary available — thread ${threadId} is not one of your conversations.`;
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

          const filesSection = formatFilesSection(s.files, threadId);

          parts.push(
            `## Session summary${when}\n\n${s.text}${metaLine}${filesSection}`,
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
        "When a thread produced files, the response also includes a 'Files written during this session' " +
        "section with each file's path and a short content summary. If one of those files looks like it " +
        "holds the detail you need, follow up with `read_session_file` to fetch its contents.\n\n" +
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
