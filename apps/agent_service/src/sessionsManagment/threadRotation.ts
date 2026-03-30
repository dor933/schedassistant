import crypto from "node:crypto";
import { Agent, Group, SingleChat, Thread } from "@scheduling-agent/database";
import { logger } from "../logger";

/**
 * Creates a fresh thread (T₂) and points the conversation's
 * `active_thread_id` at it.
 *
 * Called after a successful summarization on T₁ so the next
 * `graph.invoke` starts with an empty checkpoint.
 *
 * Returns the new thread ID.
 */
export async function rotateThread(
  groupId: string | null | undefined,
  singleChatId: string | null | undefined,
  agentId: string | null | undefined,
): Promise<string> {
  const newThreadId = crypto.randomUUID();

  await Thread.create({
    id: newThreadId,
    userId: null,
    agentId: agentId ?? null,
    lastActivityAt: new Date(),
  });

  if (groupId) {
    await Group.update(
      { activeThreadId: newThreadId },
      { where: { id: groupId } },
    );
  } else if (singleChatId) {
    const aid =
      agentId ??
      (await SingleChat.findByPk(singleChatId, { attributes: ["agentId"] }))?.agentId ??
      null;
    if (aid) {
      await Agent.update({ activeThreadId: newThreadId }, { where: { id: aid } });
      await SingleChat.update({ activeThreadId: newThreadId }, { where: { agentId: aid } });
    }
  }

  logger.info("Thread rotated", { newThreadId, groupId, singleChatId, agentId });
  return newThreadId;
}
