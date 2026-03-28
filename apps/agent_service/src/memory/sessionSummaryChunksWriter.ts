import { Thread, EpisodicMemory } from "@scheduling-agent/database";
import type { AgentId, UserId, SessionSummary } from "@scheduling-agent/types";

/**
 * Persists the session summary to the `threads` row and inserts
 * semantically coherent chunks into `episodic_memory`.
 *
 * Called from the sessionSummarization graph node after the LLM produces
 * the structured output (summary + chunks).
 *
 * @param threadId   - Identifies the session row to update.
 * @param userId     - Owner user; written to every episodic row.
 * @param agentId    - The agent this memory belongs to (persists across conversations).
 * @param summary    - Free-form summary text from the LLM.
 * @param chunks     - Semantically self-contained text chunks from the LLM.
 * @param embedChunk - Callback that turns a text chunk into an embedding vector.
 */
export async function persistSummarizationResult(
  threadId: string,
  userId: UserId,
  agentId: AgentId | null,
  summary: string,
  chunks: string[],
  embedChunk: (text: string) => Promise<number[]>,
): Promise<void> {
  const now = new Date();
  const summaryPayload: SessionSummary = {
    text: summary,
    createdAt: now.toISOString(),
    messageCount: undefined,
  };

  // Write summary JSONB to the threads row.
  await Thread.update(
    {
      summary: summaryPayload,
      summarizedAt: now,
    },
    { where: { id: threadId } },
  );

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
