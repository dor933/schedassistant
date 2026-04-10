import { sequelize } from "@scheduling-agent/database";
import type { AgentId } from "@scheduling-agent/types";
import { QueryTypes } from "sequelize";

import { logger } from "../logger";

/**
 * Retrieves the top-K most similar episodic memory chunks for a query embedding.
 *
 * **Isolation:** filters by `agent_id` so memory follows the agent across
 * conversations (single chats, groups, or reassignments).
 *
 * Optionally filters by `repositoryId` and/or `projectId` to scope results
 * to a specific repo or project (used by the epic orchestrator).
 *
 * @param agentId        - The agent whose episodic memory to search.
 * @param embedding      - Query vector (same dimension as `episodic_memory.embedding`).
 * @param topK           - Number of chunks to return (default 5).
 * @param options        - Optional filters for repo/project scoping.
 */
export async function retrieveEpisodicMemory(
  agentId: AgentId | null,
  embedding: number[],
  topK = 5,
  options?: { repositoryId?: string; projectId?: string },
): Promise<string[]> {
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

  try {
    const rows = await sequelize.query<{ content: string }>(
      `SELECT ep.content
       FROM   episodic_memory ep
       WHERE  ${conditions.join(" AND ")}
       ORDER  BY ep.embedding <=> :embedding::vector
       LIMIT  :topK`,
      {
        replacements,
        type: QueryTypes.SELECT,
      },
    );

    return rows.map((r) => r.content);
  } catch (err) {
    logger.error("Episodic memory retrieval failed", { agentId, error: String(err) });
    return [];
  }
}
