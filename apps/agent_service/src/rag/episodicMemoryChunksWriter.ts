import { EpisodicMemory } from "@scheduling-agent/database";
import type { AgentId, UserId } from "@scheduling-agent/types";

/**
 * Inserts semantically coherent chunks into `episodic_memory`.
 *
 * @param threadId   - Identifies the session row to update.
 * @param userId     - Owner user; written to every episodic row.
 * @param agentId    - The agent this memory belongs to (persists across conversations).
 * @param chunks     - Semantically self-contained text chunks from the LLM.
 * @param embedChunk - Callback that turns a text chunk into an embedding vector.
 */
export async function insertEpisodicMemoryChunks(
  threadId: string,
  userId: UserId,
  agentId: AgentId | null,
  chunks: string[],
  embedChunk: (text: string) => Promise<number[]>,
): Promise<void> {
  const now = new Date();

  // Embed each chunk and insert into episodic_memory (scoped to agent_id).
  for (let i = 0; i < chunks.length; i++) {
    const embedding = await embedChunk(chunks[i]);

    await EpisodicMemory.create({
      userId,
      threadId,
      agentId,
      content: chunks[i],
      embedding,
      metadata: {
        threadId,
        agentId,
        chunkIndex: i,
        summarizedAt: now.toISOString(),
      },
    });
  }
}
