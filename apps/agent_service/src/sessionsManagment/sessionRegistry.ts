import { Thread } from "@scheduling-agent/database";
import type { UserId } from "@scheduling-agent/types";
import { logger } from "../logger";

export type EnsureSessionScope = {
  agentId?: string | null;
};

/**
 * Ensures a `threads` row exists for the given thread and
 * user. Creates one if it doesn't exist yet (new conversation),
 * or returns the existing row (resumed conversation).
 *
 * For group chats and **pool-agent** direct chats (`single_chats` with an agent where
 * `group_id` IS NULL), `userId` is null — one LangGraph thread per agent, shared by
 * all users; transcript isolation is `conversation_messages.single_chat_id`.
 * A mismatch on a user-owned thread would indicate a session-isolation breach.
 */
export async function ensureSession(
  threadId: string,
  userId: UserId | null,
  scope: EnsureSessionScope = {},
): Promise<Thread> {
  const { agentId = null } = scope;

  const [session, created] = await Thread.findOrCreate({
    where: { id: threadId },
    defaults: {
      id: threadId,
      userId,
      agentId,
      lastActivityAt: new Date(),
    },
  });

  if (created) {
    logger.info("Session created", { threadId, userId, agentId });
  }

  // Isolation check only for user-owned threads (single chats), not shared group threads.
  if (!created && userId && session.userId && session.userId !== userId) {
    logger.error("Session isolation violation", { threadId, ownerUserId: session.userId, callerUserId: userId });
    throw new Error(
      `Session isolation violation: thread ${threadId} belongs to user ${session.userId}, not ${userId}.`,
    );
  }

  // Bump activity; backfill `agent_id` if the client now supplies it.
  if (!created) {
    const patch: { lastActivityAt: Date; agentId?: string | null } = { lastActivityAt: new Date() };
    if (agentId != null && session.agentId == null) {
      patch.agentId = agentId;
    }
    await session.update(patch);
  }

  return session;
}

/**
 * Marks a session's summary JSONB column and sets `summarized_at`.
 */
export async function writeSummary(
  threadId: string,
  summaryText: string,
): Promise<void> {
  logger.info("Writing session summary", { threadId, summaryLen: summaryText.length });
  await Thread.update(
    {
      summary: { text: summaryText, createdAt: new Date().toISOString() },
      summarizedAt: new Date(),
    },
    { where: { id: threadId } },
  );
}
