import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Op } from "sequelize";
import {
  Roundtable,
  RoundtableAgent,
  RoundtableUser,
  Agent,
  User,
} from "@scheduling-agent/database";
import type { AgentId } from "@scheduling-agent/types";

import { logger } from "../logger";

/**
 * Tools that let a primary agent recall the roundtables it participated
 * in, scoped strictly to roundtables where its `agentId` appears in
 * `roundtable_agents`. The `threads` table is intentionally NOT
 * involved — `roundtables.short_summary` and `roundtables.summary`
 * carry everything an agent needs, so we don't make the agent traverse
 * thread → summary just to read a roundtable's outcome.
 *
 * Designed as a two-step cascade:
 *   1. `list_my_roundtables`  → cheap metadata listing.
 *   2. `get_roundtable_overview` → topic + short_summary (3-5 sentences),
 *      with the long structured `summary` returned as well so the agent
 *      can drop into it when one paragraph isn't enough.
 *
 * Both tools fail closed if `agentId` is missing — they are useless
 * outside the context of a specific calling agent.
 */

// ── list_my_roundtables ───────────────────────────────────────────────

const listSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Optional case-insensitive substring to match against the roundtable's `topic`. " +
        "Leave unset to list every roundtable you participated in.",
    ),
  status: z
    .enum(["pending", "running", "waiting_for_user", "completed", "failed"])
    .optional()
    .describe(
      "Optional status filter. Most recall use cases want `completed` (the only " +
        "status that has a populated summary).",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum number of rows to return. Defaults to 20, cap is 50."),
});

export function ListMyRoundtablesTool(callerAgentId: AgentId | null) {
  return tool(
    async (input) => {
      if (!callerAgentId) {
        return "No agent context — cannot list your roundtables.";
      }
      const { query, status } = input;
      const limit = input.limit ?? 20;

      try {
        // Step 1: which roundtables is this agent in?
        const memberships = await RoundtableAgent.findAll({
          where: { agentId: callerAgentId },
          attributes: ["roundtableId"],
        });
        if (memberships.length === 0) {
          return JSON.stringify({
            count: 0,
            roundtables: [],
            note: "You have not participated in any roundtables yet.",
          });
        }
        const roundtableIds = [...new Set(memberships.map((m) => m.roundtableId))];

        // Step 2: pull metadata for those, applying optional filters.
        const where: Record<string, unknown> = { id: roundtableIds };
        if (status) where.status = status;
        if (query) where.topic = { [Op.iLike]: `%${query}%` };

        const rows = await Roundtable.findAll({
          where,
          attributes: [
            "id",
            "threadId",
            "topic",
            "status",
            "currentRound",
            "maxTurnsPerAgent",
            "shortSummary",
            "summary",
            "summaryGeneratedAt",
            "createdAt",
          ],
          order: [["createdAt", "DESC"]],
          limit,
        });

        return JSON.stringify({
          count: rows.length,
          roundtables: rows.map((r) => ({
            roundtableId: r.id,
            threadId: r.threadId,
            topic: r.topic,
            status: r.status,
            currentRound: r.currentRound,
            maxTurnsPerAgent: r.maxTurnsPerAgent,
            hasShortSummary: !!r.shortSummary,
            hasSummary: !!r.summary,
            summaryGeneratedAt: r.summaryGeneratedAt
              ? r.summaryGeneratedAt.toISOString()
              : null,
            createdAt: r.createdAt.toISOString(),
          })),
          note:
            "Use `get_roundtable_overview` with a `roundtableId` from this list to " +
            "pull the topic + short_summary (and the full structured summary if you " +
            "need more depth).",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("list_my_roundtables failed", {
          callerAgentId,
          error: message,
        });
        return `Error listing your roundtables: ${message}`;
      }
    },
    {
      name: "list_my_roundtables",
      description:
        "List the roundtables you (the calling agent) participated in. Returns metadata only — " +
        "topic, status, round counts, and flags indicating whether short/long summaries are " +
        "available. NO summary text in the response, so this is cheap to call. Use it to " +
        "discover candidate roundtables, then call `get_roundtable_overview` with a specific " +
        "`roundtableId` to read the actual content.\n\n" +
        "Filtering: pass `status='completed'` to limit to roundtables whose summary is final, " +
        "or `query='...'` to substring-match the topic.\n\n" +
        "Scoped to your agent only — you cannot see roundtables you weren't a participant of.",
      schema: listSchema,
    },
  );
}

// ── get_roundtable_overview ───────────────────────────────────────────

const overviewSchema = z.object({
  roundtableId: z
    .string()
    .uuid()
    .describe(
      "Roundtable id from `list_my_roundtables` (the `roundtableId` field). " +
        "Must be a roundtable you participated in.",
    ),
});

export function GetRoundtableOverviewTool(callerAgentId: AgentId | null) {
  return tool(
    async (input) => {
      if (!callerAgentId) {
        return "No agent context — cannot fetch roundtable overview.";
      }
      const roundtableId = input.roundtableId?.trim();
      if (!roundtableId) return "No roundtableId provided.";

      try {
        // Access gate: caller must be a participant.
        const membership = await RoundtableAgent.findOne({
          where: { roundtableId, agentId: callerAgentId },
          attributes: ["id"],
        });
        if (!membership) {
          return `No overview available — you were not a participant in roundtable ${roundtableId}.`;
        }

        const r = await Roundtable.findByPk(roundtableId, {
          attributes: [
            "id",
            "threadId",
            "topic",
            "status",
            "currentRound",
            "maxTurnsPerAgent",
            "shortSummary",
            "summary",
            "summaryGeneratedAt",
            "createdAt",
          ],
        });
        if (!r) {
          return `Roundtable ${roundtableId} not found.`;
        }

        // Pull participant rosters for context — both agents and users.
        const [agentRows, userRows] = await Promise.all([
          RoundtableAgent.findAll({
            where: { roundtableId },
            attributes: ["agentId", "turnOrder"],
            order: [["turnOrder", "ASC"]],
            include: [
              {
                association: "agent",
                attributes: ["agentName", "definition"],
              },
            ],
          }),
          RoundtableUser.findAll({
            where: { roundtableId },
            attributes: ["userId", "turnOrder"],
            order: [["turnOrder", "ASC"]],
            include: [
              {
                association: "user",
                attributes: ["id", "displayName"],
              },
            ],
          }),
        ]);

        const participants = {
          agents: agentRows.map((ra) => {
            const a = (ra as any).agent as Agent | null;
            return {
              agentId: ra.agentId,
              name: a?.agentName?.trim() || a?.definition || ra.agentId,
            };
          }),
          users: userRows.map((ru) => {
            const u = (ru as any).user as User | null;
            return {
              userId: ru.userId,
              displayName:
                u?.displayName?.trim() || `User #${ru.userId}`,
            };
          }),
        };

        return JSON.stringify({
          roundtableId: r.id,
          threadId: r.threadId,
          topic: r.topic,
          status: r.status,
          round: { current: r.currentRound, max: r.maxTurnsPerAgent },
          createdAt: r.createdAt.toISOString(),
          summaryGeneratedAt: r.summaryGeneratedAt
            ? r.summaryGeneratedAt.toISOString()
            : null,
          participants,
          // Prefer short_summary for triage; fall back to summary if the
          // short pass failed or this row predates the short_summary
          // column. Both are surfaced so the agent can pick whichever
          // depth it needs without a second tool call.
          shortSummary: r.shortSummary,
          summary: r.summary,
          note:
            r.shortSummary
              ? "Read `shortSummary` first (one paragraph). Drop into `summary` only if you need the full structured breakdown (key points / agreements / disagreements / per-agent contributions)."
              : r.summary
                ? "This roundtable has only the long structured `summary` — `shortSummary` was not generated (older row or distillation failed)."
                : r.status === "completed"
                  ? "This roundtable completed without producing a summary."
                  : `This roundtable has no summary yet (status=${r.status}).`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("get_roundtable_overview failed", {
          callerAgentId,
          roundtableId,
          error: message,
        });
        return `Error loading roundtable overview: ${message}`;
      }
    },
    {
      name: "get_roundtable_overview",
      description:
        "Fetch the topic + summaries of a roundtable you participated in.\n\n" +
        "Returns BOTH:\n" +
        "  - `shortSummary` — one-paragraph distillation (3-5 sentences). Read this FIRST.\n" +
        "  - `summary`      — full structured markdown (Topic / Key Points / Agreements / " +
        "Disagreements & Open Questions / Per-Agent Contributions, ~350 words). Drop into " +
        "this only if the short version isn't enough.\n\n" +
        "Also returns the participant roster (agents + users) and round counts.\n\n" +
        "Access-gated: the tool only returns data when YOUR agentId appears in the " +
        "roundtable's participant list. Obtain `roundtableId` from `list_my_roundtables`.",
      schema: overviewSchema,
    },
  );
}
