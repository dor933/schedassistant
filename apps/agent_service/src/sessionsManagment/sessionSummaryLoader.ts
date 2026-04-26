import { Thread } from "@scheduling-agent/database";
import type { AgentId, SessionSummary } from "@scheduling-agent/types";
import { Op } from "sequelize";
import { logger } from "../logger";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const NUM_SUMMARIES = 5;

export type LoadRecentSessionSummariesOptions = {
  /**
   * Omit summaries for this thread (e.g. the active conversation) so we only pull
   * prior threads belonging to the same agent.
   */
  excludeThreadId?: string;
};

/**
 * Loads up to NUM_SUMMARIES of the most recent session summaries for the given **agent**
 * from `threads` where `summary` is set and `summarized_at` is within the
 * last 48 hours. Agent-level scoping ensures memory persists across conversations.
 */
export async function loadRecentSessionSummaries(
  agentId: AgentId | null,
  options: LoadRecentSessionSummariesOptions = {},
): Promise<SessionSummary[]> {
  if (!agentId) return [];

  const since = new Date(Date.now() - WEEK_MS);
  const { excludeThreadId } = options;

  const threadFilter =
    excludeThreadId != null && excludeThreadId !== ""
      ? { id: { [Op.ne]: excludeThreadId } }
      : {};

  try {
    const rows = await Thread.findAll({
      where: {
        agentId,
        ...threadFilter,
        summary: { [Op.ne]: null },
        summarizedAt: { [Op.gte]: since },
      },
      order: [["summarizedAt", "DESC"]],
      limit: NUM_SUMMARIES,
    });

    return rows
      .map((r) => r.summary)
      .filter((s): s is SessionSummary => s != null);
  } catch (err) {
    logger.error("Session summary load failed", { agentId, error: String(err) });
    return [];
  }
}
