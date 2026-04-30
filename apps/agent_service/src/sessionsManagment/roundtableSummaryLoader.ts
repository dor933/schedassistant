import { Roundtable, RoundtableAgent } from "@scheduling-agent/database";
import { Op } from "sequelize";
import type { AgentId } from "@scheduling-agent/types";
import { logger } from "../logger";

export interface RecentRoundtableSummary {
  roundtableId: string;
  topic: string;
  summary: string;
  completedAt: string;
  participantCount: number;
}

/**
 * Loads the most recent completed roundtable summaries that the given agent
 * participated in. Returns up to `limit` entries, newest first.
 *
 * Only includes roundtables that have a non-null summary (i.e. the
 * summarizer ran successfully on completion).
 */
export async function loadRecentRoundtableSummaries(
  agentId: AgentId | null | undefined,
  opts: { limit?: number } = {},
): Promise<RecentRoundtableSummary[]> {
  if (!agentId) return [];

  const limit = opts.limit ?? 2;

  try {
    // Find roundtable IDs this agent participated in
    const participations = await RoundtableAgent.findAll({
      where: { agentId },
      attributes: ["roundtableId"],
      order: [["createdAt", "DESC"]],
      limit: limit * 3, // over-fetch to account for non-completed ones
    });

    if (participations.length === 0) return [];

    const roundtableIds = participations.map((p) => p.roundtableId);

    const roundtables = await Roundtable.findAll({
      where: {
        id: { [Op.in]: roundtableIds },
        status: "completed",
        summary: { [Op.ne]: null },
      },
      attributes: ["id", "topic", "summary", "summaryGeneratedAt", "updatedAt"],
      order: [["updatedAt", "DESC"]],
      limit,
    });

    return roundtables.map((rt) => ({
      roundtableId: rt.id,
      topic: rt.topic,
      summary: rt.summary!,
      completedAt: (rt.summaryGeneratedAt ?? rt.updatedAt).toISOString(),
      participantCount: 0, // filled below if needed
    }));
  } catch (err) {
    logger.warn("Failed to load roundtable summaries for context", {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Formats roundtable summaries into a system prompt section.
 *
 * The saved summary already contains its own "## Topic" section, so avoid
 * repeating the full roundtable topic before it. Keep the completion timestamp
 * outside the summary so the agent can judge freshness.
 * Returns empty string if there are no summaries.
 */
export function formatRoundtableSummariesSection(
  summaries: RecentRoundtableSummary[],
): string {
  if (summaries.length === 0) return "";

  const lines: string[] = [
    "## Recent roundtable summaries",
    "These are summaries from completed multi-agent roundtables you participated in. " +
    "Use them as past context when relevant.",
    "",
  ];

  for (const s of summaries) {
    lines.push(`_Handled: ${new Date(s.completedAt).toISOString()}_`);
    lines.push("");
    lines.push(s.summary.trim());
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
