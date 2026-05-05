import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Op } from "sequelize";
import { Thread } from "@scheduling-agent/database";
import type { AgentId, SessionSummary } from "@scheduling-agent/types";

import { logger } from "../logger";

/**
 * Discovery counterpart to `get_thread_summary`. Lets a primary agent
 * enumerate the threads it actually owns (single-chat / group threads
 * where `threads.agent_id` matches), so it has a non-vector entry point
 * into past conversations. After picking a threadId, the agent calls
 * `get_thread_summary` for the manifest and reads the listed paths
 * (`<workspacePath>/threads/<threadId>/...`) with its built-in file
 * tools.
 *
 * Roundtable threads are intentionally excluded — they're discoverable
 * through `list_my_roundtables`. Keeping the two listings cleanly
 * scoped means the agent doesn't see the same conversation twice under
 * two different framings.
 *
 * Why this exists: the previous "vector search → thread_id from chunk
 * metadata" path is unreliable when the agent doesn't have a strong
 * semantic query, and useless before any episodic memory has been
 * embedded. With frequent thread rotation that gap shows up daily.
 */
const SUMMARY_PREVIEW_CHARS = 240;

const listThreadsSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Optional case-insensitive substring matched against the thread's title " +
        "or summary text. Leave unset to list every thread you own.",
    ),
  hasSummaryOnly: z
    .boolean()
    .optional()
    .describe(
      "When true, only return threads that already have a saved session summary " +
        "(i.e. ones you can immediately follow up on with `get_thread_summary`).",
    ),
  startTime: z
    .coerce.date()
    .optional()
    .describe(
      "Optional inclusive lower bound on `threads.updated_at` (when the thread row was last " +
        "modified in the database). Pass an ISO 8601 datetime (e.g. `2026-05-01T00:00:00.000Z`). " +
        "Omit to leave the start open.",
    ),
  endTime: z
    .coerce.date()
    .optional()
    .describe(
      "Optional inclusive upper bound on `threads.updated_at`. Pass an ISO 8601 datetime. " +
        "Omit to leave the end open. Use with `startTime` to narrow the recall window.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum number of threads to return. Defaults to 20, capped at 50."),
});

export function ListMyThreadsTool(callerAgentId: AgentId | null) {
  return tool(
    async (input) => {
      if (!callerAgentId) {
        return "No agent context — cannot list your threads.";
      }
      const { query, hasSummaryOnly, startTime, endTime } = input;
      const limit = input.limit ?? 20;

      try {
        const where: Record<string, unknown> = { agentId: callerAgentId };
        if (startTime !== undefined || endTime !== undefined) {
          where.updatedAt = {
            ...(startTime !== undefined ? { [Op.gte]: startTime } : {}),
            ...(endTime !== undefined ? { [Op.lte]: endTime } : {}),
          };
        }
        // Substring match on the title column happens in SQL; matching
        // against the JSONB summary text is done in JS below — there's
        // no precedent in this codebase for Sequelize.literal-based
        // JSONB ILIKE and the row count is bounded by `limit` so the
        // post-filter is cheap.
        if (query) {
          where.title = { [Op.iLike]: `%${query}%` };
        }

        // Pull a slightly larger page when we'll be filtering further
        // in JS (hasSummaryOnly), so the final response still has up to
        // `limit` rows. Capped at the schema max.
        const fetchLimit = hasSummaryOnly ? Math.min(limit * 2, 50) : limit;

        const rows = await Thread.findAll({
          where,
          attributes: [
            "id",
            "title",
            "summary",
            "summarizedAt",
            "lastActivityAt",
            "archivedAt",
            "createdAt",
            "updatedAt",
          ],
          // Most-recently-active first — matches what the user sees in
          // their conversations list and what the agent most likely
          // wants to recall.
          order: [
            ["last_activity_at", "DESC NULLS LAST"],
            ["created_at", "DESC"],
          ],
          limit: fetchLimit,
        });

        let filtered = rows;
        if (hasSummaryOnly) {
          filtered = filtered.filter((t) => {
            const s = t.summary as SessionSummary | null;
            return !!s?.text;
          });
        }
        // If the user passed a query, also surface threads whose summary
        // text matches even when the title doesn't. We already filtered
        // by title in SQL — adding summary-text matches in JS broadens
        // the result without a second round-trip.
        if (query && filtered.length < limit) {
          const needle = query.toLowerCase();
          const seen = new Set(filtered.map((t) => t.id));
          const extras = await Thread.findAll({
            where: {
              agentId: callerAgentId,
              ...(startTime !== undefined || endTime !== undefined
                ? {
                    updatedAt: {
                      ...(startTime !== undefined ? { [Op.gte]: startTime } : {}),
                      ...(endTime !== undefined ? { [Op.lte]: endTime } : {}),
                    },
                  }
                : {}),
              id: { [Op.notIn]: filtered.map((t) => t.id) },
              summary: { [Op.ne]: null },
            },
            attributes: [
              "id",
              "title",
              "summary",
              "summarizedAt",
              "lastActivityAt",
              "archivedAt",
              "createdAt",
              "updatedAt",
            ],
            order: [
              ["last_activity_at", "DESC NULLS LAST"],
              ["created_at", "DESC"],
            ],
            limit: limit * 2,
          });
          for (const t of extras) {
            if (filtered.length >= limit) break;
            if (seen.has(t.id)) continue;
            const s = t.summary as SessionSummary | null;
            if (s?.text && s.text.toLowerCase().includes(needle)) {
              filtered.push(t);
              seen.add(t.id);
            }
          }
        }
        filtered = filtered.slice(0, limit);

        return JSON.stringify({
          count: filtered.length,
          threads: filtered.map((t) => {
            const s = t.summary as SessionSummary | null;
            const text = s?.text?.trim() ?? "";
            const summaryPreview =
              text.length === 0
                ? null
                : text.length > SUMMARY_PREVIEW_CHARS
                  ? `${text.slice(0, SUMMARY_PREVIEW_CHARS)}…`
                  : text;
            return {
              threadId: t.id,
              title: t.title,
              hasSummary: !!s?.text,
              summaryPreview,
              fileCount: s?.files?.length ?? 0,
              messageCount: s?.messageCount ?? null,
              summarizedAt: t.summarizedAt
                ? t.summarizedAt.toISOString()
                : null,
              lastActivityAt: t.lastActivityAt
                ? t.lastActivityAt.toISOString()
                : null,
              archivedAt: t.archivedAt ? t.archivedAt.toISOString() : null,
              createdAt: t.createdAt.toISOString(),
              updatedAt: t.updatedAt.toISOString(),
            };
          }),
          note:
            "These are single-chat and group threads where YOU are the agent. " +
            "For roundtables you participated in, use `list_my_roundtables` instead. " +
            "Once you find a candidate threadId, follow up with `get_thread_summary` " +
            "(full session summary + file manifest) and then read the listed paths " +
            "(`<workspacePath>/threads/<threadId>/...`) directly with your built-in " +
            "file tools (`Read`/`Grep`/`Glob` for Anthropic SDK, `shell` for Codex SDK). " +
            "Do NOT invent filenames the manifest doesn't list.",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("list_my_threads failed", {
          callerAgentId,
          error: message,
        });
        return `Error listing your threads: ${message}`;
      }
    },
    {
      name: "list_my_threads",
      description:
        "List the conversation threads (single chats and group chats) where YOU are the " +
        "owning agent. Returns metadata only — id, title, summary preview (~240 chars), " +
        "file count, last-activity (`last_activity_at`), row last-modified (`updated_at`), " +
        "created and archived timestamps. Cheap to call; surfaces NO full session " +
        "transcripts or full summaries. Roundtable threads are NOT included here — use " +
        "`list_my_roundtables` for those.\n\n" +
        "Use this as the entry point when the user asks about something you remember from " +
        "a previous conversation but you don't have a precise enough query for " +
        "`recall_episodic_memory` to surface it. Pick a candidate threadId from the list, " +
        "then call:\n" +
        "  - `get_thread_summary(threadId)` for the full structured summary + file manifest.\n" +
        "  - Open any path the manifest lists (under `<workspacePath>/threads/<threadId>/`) " +
        "directly with your built-in file tools (`Read`/`Grep`/`Glob` for Anthropic SDK, " +
        "`shell` for Codex SDK). Do NOT invent filenames the manifest doesn't list.\n\n" +
        "Filters: `query` (substring match against title + summary text), `hasSummaryOnly` " +
        "(skip threads not yet summarized), optional `startTime` / `endTime` (ISO 8601) — " +
        "inclusive bounds on `threads.updated_at` (last time the thread row was modified).",
      schema: listThreadsSchema,
    },
  );
}
