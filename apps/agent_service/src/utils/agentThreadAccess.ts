import { Thread, Roundtable, RoundtableAgent } from "@scheduling-agent/database";
import type { AgentId } from "@scheduling-agent/types";

/**
 * Authoritative "can this agent see this thread" check used by every
 * tool that exposes thread-scoped data — `get_thread_summary`,
 * `list_my_threads`.
 *
 * Resolution order:
 *   1. Direct ownership — `threads.agent_id === agentId`. Covers
 *      single chats and group chats: in both, `Thread.agent_id` is
 *      stamped to the chat/group's orchestrator agent at thread
 *      creation, so this single column captures the relationship for
 *      the common case without any joins.
 *   2. Roundtable participation — for multi-agent roundtable threads
 *      `Thread.agent_id` is `null` (no single owner). The
 *      participation list lives in `roundtable_agents`, joined via
 *      `roundtables.thread_id`. We only do this lookup when path 1
 *      didn't match, so single-chat/group access stays one query.
 *
 * Returns `false` (rather than throwing) for unknown thread ids so
 * callers can render a generic "no access" message without leaking
 * whether the thread exists at all.
 *
 * Why this replaced the previous "do you have an episodic_memory row
 * for this thread?" gate:
 *   - The old gate only became true after `sessionSummarizationNode`
 *     embedded chunks for the thread, so an in-flight or never-
 *     summarized thread of YOUR OWN was unreachable.
 *   - It granted access by side effect — if an agent ever called
 *     `save_episodic_memory` referencing some other thread's id, it
 *     would suddenly "have access" to that thread.
 *   - It traversed an unrelated table to answer a question the
 *     `threads` row already answers directly.
 */
export async function agentMayAccessThread(
  agentId: AgentId | null | undefined,
  threadId: string | null | undefined,
): Promise<boolean> {
  if (!agentId || !threadId) return false;

  const thread = await Thread.findByPk(threadId, {
    attributes: ["id", "agentId"],
  });
  if (!thread) return false;

  // Path 1: single-chat / group thread — direct ownership match.
  if (thread.agentId && thread.agentId === agentId) return true;

  // Path 2: roundtable thread (agent_id is null on the thread row,
  // participants are listed on roundtable_agents).
  if (thread.agentId === null) {
    const roundtable = await Roundtable.findOne({
      where: { threadId },
      attributes: ["id"],
    });
    if (!roundtable) return false;
    const membership = await RoundtableAgent.findOne({
      where: { roundtableId: roundtable.id, agentId },
      attributes: ["id"],
    });
    return !!membership;
  }

  return false;
}
