import { Op } from "sequelize";
import {
  Agent,
  RoundtableMessage,
  User,
} from "@scheduling-agent/database";
import type { AgentId, UserId } from "@scheduling-agent/types";
import { logger } from "../logger";

/**
 * Loads every prior contribution (agent reply OR user message) in the current
 * roundtable so the per-agent context builder can render an attribution-safe
 * transcript for whichever agent is about to take its turn.
 *
 * Why this exists: the LangGraph checkpoint already restores the shared
 * `state.messages` array across all participating agents under one thread_id,
 * and the legacy `bindTools` branch in `roundtableCallModel.ts` collapses
 * other-agent blocks into named HumanMessages so attribution is preserved.
 * That code path is unreachable for Anthropic / Codex SDK agents — those
 * branches return into the SDK runner BEFORE reaching the per-block grouping
 * logic, then `extractLatestUserText` discards everything except the latest
 * moderator HumanMessage. The result is that SDK-vendor participants saw an
 * empty transcript and were instructed to "build on previous contributions"
 * with no contributions in scope.
 *
 * Loading from `roundtable_messages` (the same table the UI renders from)
 * sidesteps two fragility classes the LangGraph-state route would inherit:
 *   - BaseMessage shape ambiguity after Postgres rehydration (class
 *     instances vs serialized plain objects, `additional_kwargs.agentId`
 *     surviving the round-trip, etc.).
 *   - Drift between what the agents see and what the user sees in the UI
 *     (the table is the source of truth for display).
 */

export interface PriorRoundtableTurn {
  /** Round number this contribution was made in (0-indexed, matches DB). */
  roundNumber: number;
  /** Wall-clock time the row was inserted. Used for tie-break ordering within a round. */
  createdAt: Date;
  /** Display name to show as the speaker. */
  speakerLabel: string;
  /** Whether the speaker is the agent currently building its prompt — for "**You**" marking. */
  isSelf: boolean;
  /** Whether the speaker is a human participant. Drives wording in the rendered section. */
  isHuman: boolean;
  /** The contribution text. Empty string is filtered out before this point. */
  content: string;
}

/**
 * Loads prior turns for a roundtable, ordered chronologically.
 *
 * Includes the current agent's own past turns — necessary because each
 * Anthropic / Codex SDK roundtable invocation forces a fresh session
 * (`claudeSessionId: null` / `codexThreadId: null` in `roundtableCallModel`),
 * so the agent has no vendor-side memory of what it said in earlier rounds
 * either. The renderer marks those rows as "**You**" so the model can
 * distinguish them from peers' contributions.
 *
 * The current turn's outgoing reply is NOT in the table yet — the worker
 * inserts it AFTER the graph invoke succeeds, so a simple unfiltered SELECT
 * is correct without an explicit "exclude current turn" predicate.
 */
export async function loadPriorRoundtableTurns(
  roundtableId: string | null | undefined,
  currentAgentId: AgentId | null | undefined,
): Promise<PriorRoundtableTurn[]> {
  if (!roundtableId) return [];

  try {
    const rows = await RoundtableMessage.findAll({
      where: { roundtableId },
      order: [
        ["roundNumber", "ASC"],
        ["createdAt", "ASC"],
      ],
    });
    if (rows.length === 0) return [];

    // Resolve display names in two batched lookups — one per author kind —
    // so we don't issue one query per row.
    const agentIds = Array.from(
      new Set(
        rows
          .map((r) => r.agentId)
          .filter((id): id is AgentId => typeof id === "string" && id.length > 0),
      ),
    );
    const userIds = Array.from(
      new Set(
        rows
          .map((r) => r.userId)
          .filter((id): id is UserId => typeof id === "number"),
      ),
    );

    const [agentRows, userRows] = await Promise.all([
      agentIds.length > 0
        ? Agent.findAll({
            where: { id: { [Op.in]: agentIds } },
            attributes: ["id", "agentName", "definition"],
          })
        : Promise.resolve([]),
      userIds.length > 0
        ? User.findAll({
            where: { id: { [Op.in]: userIds } },
            attributes: ["id", "displayName"],
          })
        : Promise.resolve([]),
    ]);

    const agentLabel = new Map<string, string>();
    for (const a of agentRows) {
      agentLabel.set(
        a.id,
        a.agentName?.trim() || a.definition?.trim() || a.id,
      );
    }
    const userLabel = new Map<number, string>();
    for (const u of userRows) {
      userLabel.set(u.id, u.displayName?.trim() || `User #${u.id}`);
    }

    const turns: PriorRoundtableTurn[] = [];
    for (const r of rows) {
      const text = (r.content ?? "").trim();
      if (text.length === 0) continue;

      let speakerLabel: string;
      let isSelf = false;
      let isHuman = false;
      if (r.agentId) {
        speakerLabel = agentLabel.get(r.agentId) ?? r.agentId;
        isSelf = currentAgentId != null && r.agentId === currentAgentId;
      } else if (r.userId != null) {
        speakerLabel = userLabel.get(r.userId) ?? `User #${r.userId}`;
        isHuman = true;
      } else {
        // Defensive: rows must have exactly one of agentId/userId set per
        // the model invariant. Skip rows that violate it rather than
        // surfacing a confusing "Unknown" speaker to the agent.
        logger.warn("Roundtable: prior turn row has neither agentId nor userId", {
          roundtableId,
          rowId: r.id,
          roundNumber: r.roundNumber,
        });
        continue;
      }

      turns.push({
        roundNumber: r.roundNumber,
        createdAt: r.createdAt,
        speakerLabel,
        isSelf,
        isHuman,
        content: text,
      });
    }

    return turns;
  } catch (err) {
    logger.warn("Failed to load prior roundtable turns for context", {
      roundtableId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Renders the loaded turns into a system-prompt section. Returns empty string
 * when there is nothing to show (first speaker in round 0).
 *
 * The format groups by round so the model can scan "what happened when".
 * Each contribution is fenced inside a quoted block to make boundaries
 * unambiguous when the contribution itself contains markdown headings.
 */
export function formatPriorTurnsSection(
  turns: PriorRoundtableTurn[],
): string {
  if (turns.length === 0) return "";

  const lines: string[] = [
    "## Conversation so far",
    "Here is the verbatim transcript of every prior contribution in this roundtable, in chronological order. " +
      "Read it before responding — your turn instruction below tells you to build on these.",
    "",
  ];

  let lastRound = -1;
  for (const t of turns) {
    if (t.roundNumber !== lastRound) {
      lines.push(`### Round ${t.roundNumber + 1}`);
      lines.push("");
      lastRound = t.roundNumber;
    }

    const speakerSuffix = t.isSelf
      ? " — **(you)**"
      : t.isHuman
        ? " — *human participant*"
        : "";
    lines.push(`**${t.speakerLabel}**${speakerSuffix}:`);

    // Quote each line of the contribution so nested markdown headings inside
    // the body don't visually merge into the surrounding prompt structure.
    for (const bodyLine of t.content.split(/\r?\n/)) {
      lines.push(`> ${bodyLine}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
