import crypto from "node:crypto";
import { Agent, Group, SingleChat, Thread } from "@scheduling-agent/database";
import { logger } from "../logger";

/**
 * Creates a fresh thread (T₂) and points the agent's `active_thread_id` at it.
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

  let aid = agentId ?? null;
  if (!aid && groupId) {
    const g = await Group.findByPk(groupId, { attributes: ["agentId"] });
    aid = g?.agentId ?? null;
  }
  if (!aid && singleChatId) {
    const sc = await SingleChat.findByPk(singleChatId, { attributes: ["agentId"] });
    aid = sc?.agentId ?? null;
  }

  await Thread.create({
    id: newThreadId,
    userId: null,
    agentId: aid ?? null,
    lastActivityAt: new Date(),
  });

  if (aid) {
    await Agent.update({ activeThreadId: newThreadId }, { where: { id: aid } });
  }

  logger.info("Thread rotated", { newThreadId, groupId, singleChatId, agentId: aid });
  return newThreadId;
}
