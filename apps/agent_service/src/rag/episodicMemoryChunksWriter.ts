import { EpisodicMemory } from "@scheduling-agent/database";
import type {
  AgentId,
  ProjectId,
  RepositoryId,
  UserId,
} from "@scheduling-agent/types";

/**
 * Optional scoping + provenance fields for episodic chunks.
 */
export interface EpisodicMemoryInsertOptions {
  /** Scope the chunk to a specific repository for retrieval filtering. */
  repositoryId?: RepositoryId | null;
  /** Scope the chunk to a specific project for retrieval filtering. */
  projectId?: ProjectId | null;
  /** Provenance tag stored on metadata (e.g. "session_summarization", "agent_save"). */
  source?: string;
  /** Extra metadata keys merged into the stored metadata JSONB. */
  extraMetadata?: Record<string, unknown>;
}

/**
 * Inserts semantically coherent chunks into `episodic_memory`.
 *
 * @param threadId   - Identifies the session row to update.
 * @param userId     - Owner user; written to every episodic row.
 * @param agentId    - The agent this memory belongs to (persists across conversations).
 * @param chunks     - Semantically self-contained text chunks from the LLM.
 * @param embedChunk - Callback that turns a text chunk into an embedding vector.
 * @param options    - Optional scoping (repository/project) and provenance metadata.
 */
export async function insertEpisodicMemoryChunks(
  threadId: string,
  userId: UserId,
  agentId: AgentId | null,
  chunks: string[],
  embedChunk: (text: string) => Promise<number[]>,
  options: EpisodicMemoryInsertOptions = {},
): Promise<void> {
  const now = new Date();
  const { repositoryId = null, projectId = null, source, extraMetadata } = options;

  // Embed each chunk and insert into episodic_memory (scoped to agent_id,
  // and optionally repository_id / project_id).
  for (let i = 0; i < chunks.length; i++) {
    const embedding = await embedChunk(chunks[i]);

    await EpisodicMemory.create({
      userId,
      threadId,
      agentId,
      repositoryId,
      projectId,
      content: chunks[i],
      embedding,
      metadata: {
        threadId,
        agentId,
        chunkIndex: i,
        summarizedAt: now.toISOString(),
        ...(source ? { source } : {}),
        ...(repositoryId ? { repositoryId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(extraMetadata ?? {}),
      },
    });
  }
}
