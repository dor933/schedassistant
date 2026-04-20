import { sequelize } from "@scheduling-agent/database";
import type { AgentId } from "@scheduling-agent/types";
import { QueryTypes } from "sequelize";

import { logger } from "../logger";

/**
 * Half-life in days for episodic memory freshness decay.
 * Memories lose half their relevance weight after this many days.
 * Set to 0 to disable decay (pure similarity ranking).
 */
const MEMORY_HALF_LIFE_DAYS = parseInt(
  process.env.EPISODIC_MEMORY_HALF_LIFE_DAYS ?? "30",
  10,
);

/**
 * Candidate pool multiplier — we fetch more candidates than topK so the
 * freshness re-ranking has a meaningful pool to choose from.
 */
const CANDIDATE_MULTIPLIER = 3;

/**
 * Retrieves the top-K most similar episodic memory chunks for a query embedding,
 * with optional freshness decay that deprioritizes older memories.
 *
 * **Isolation:** filters by `agent_id` so memory follows the agent across
 * conversations (single chats, groups, or reassignments).
 *
 * **Freshness decay:** when EPISODIC_MEMORY_HALF_LIFE_DAYS > 0, similarity
 * scores are multiplied by `exp(-age_days * ln(2) / half_life)`. This means
 * a memory that is `half_life` days old gets half the weight of an identical
 * match from today. Fetches a larger candidate pool and re-ranks in SQL.
 *
 * Optionally filters by `repositoryId` and/or `projectId` to scope results
 * to a specific repo or project (used by the epic orchestrator).
 *
 * @param agentId        - The agent whose episodic memory to search.
 * @param embedding      - Query vector (same dimension as `episodic_memory.embedding`).
 * @param topK           - Number of chunks to return (default 5).
 * @param options        - Optional filters for repo/project scoping.
 */
export interface EpisodicMemoryHit {
  content: string;
  threadId: string;
  createdAt: Date;
}

export async function retrieveEpisodicMemory(
  agentId: AgentId | null,
  embedding: number[],
  topK = 5,
  options?: { repositoryId?: string; projectId?: string },
): Promise<EpisodicMemoryHit[]> {
  if (!agentId) {
    return [];
  }

  const vectorLiteral = `[${embedding.join(",")}]`;

  // Build dynamic WHERE clause
  const conditions = ["ep.agent_id = :agentId"];
  const replacements: Record<string, unknown> = {
    agentId,
    embedding: vectorLiteral,
    topK,
  };

  if (options?.repositoryId) {
    conditions.push("ep.repository_id = :repositoryId");
    replacements.repositoryId = options.repositoryId;
  }

  if (options?.projectId) {
    conditions.push("ep.project_id = :projectId");
    replacements.projectId = options.projectId;
  }

  const useDecay = MEMORY_HALF_LIFE_DAYS > 0;

  try {
    let query: string;

    if (useDecay) {
      // Fetch a larger candidate pool by raw similarity, then re-rank with decay.
      // decay = exp(-age_days * ln(2) / half_life)
      // similarity = 1 - cosine_distance  (cosine_distance is the <=> operator)
      // final_score = similarity * decay
      const candidateLimit = topK * CANDIDATE_MULTIPLIER;
      replacements.candidateLimit = candidateLimit;
      replacements.halfLife = MEMORY_HALF_LIFE_DAYS;

      query = `
        SELECT content, thread_id AS "threadId", created_at AS "createdAt" FROM (
          SELECT ep.content,
                 ep.thread_id,
                 ep.created_at,
                 (1.0 - (ep.embedding <=> :embedding::vector))
                   * exp(
                       -1.0
                       * GREATEST(EXTRACT(EPOCH FROM (now() - ep.created_at)) / 86400.0, 0)
                       * ln(2.0)
                       / :halfLife
                     ) AS score
          FROM   episodic_memory ep
          WHERE  ${conditions.join(" AND ")}
          ORDER  BY ep.embedding <=> :embedding::vector
          LIMIT  :candidateLimit
        ) ranked
        ORDER BY ranked.score DESC
        LIMIT :topK`;
    } else {
      // No decay — pure similarity ranking
      query = `
        SELECT ep.content,
               ep.thread_id AS "threadId",
               ep.created_at AS "createdAt"
        FROM   episodic_memory ep
        WHERE  ${conditions.join(" AND ")}
        ORDER  BY ep.embedding <=> :embedding::vector
        LIMIT  :topK`;
    }

    const rows = await sequelize.query<EpisodicMemoryHit>(query, {
      replacements,
      type: QueryTypes.SELECT,
    });

    return rows.map((r) => ({
      content: r.content,
      threadId: r.threadId,
      createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
    }));
  } catch (err) {
    logger.error("Episodic memory retrieval failed", { agentId, error: String(err) });
    return [];
  }
}
