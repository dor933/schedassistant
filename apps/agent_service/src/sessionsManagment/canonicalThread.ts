import crypto from "node:crypto";
import { Agent, Group, SingleChat } from "@scheduling-agent/database";
import { ensureSession } from "./sessionRegistry";
import { logger } from "../logger";

/**
 * Returns the active LangGraph thread for a group or single chat, creating
 * `threads` + `agents.active_thread_id` when missing.
 */
export async function ensureCanonicalThreadId(params: {
  userId: string;
  groupId?: string | null;
  singleChatId?: string | null;
}): Promise<string> {
  const { userId, groupId, singleChatId } = params;
  const hasGroup = !!groupId;
  const hasSingle = !!singleChatId;
  if (hasGroup === hasSingle) {
    throw Object.assign(
      new Error("Exactly one of groupId or singleChatId is required."),
      {
        status: 400,
      },
    );
  }

  if (groupId) {
    const group = await Group.findByPk(groupId, {
      attributes: ["id", "agentId"],
    });
    if (!group) {
      throw Object.assign(new Error("Group not found."), { status: 404 });
    }
    const agent = await Agent.findByPk(group.agentId, {
      attributes: ["id", "activeThreadId"],
    });
    if (!agent) {
      throw Object.assign(new Error("Agent not found."), { status: 404 });
    }
    if (agent.activeThreadId) {
      return agent.activeThreadId;
    }
    const threadId = crypto.randomUUID();
    await ensureSession(threadId, null, {
      agentId: agent.id,
    });
    await Agent.update(
      { activeThreadId: threadId },
      { where: { id: agent.id } },
    );
    logger.info("Created canonical thread (group)", { groupId, threadId, agentId: agent.id });
    return threadId;
  }

  const sid = singleChatId!;
  const sc = await SingleChat.findOne({
    where: { id: sid, userId },
    attributes: ["id", "agentId"],
  });
  if (!sc) {
    throw Object.assign(new Error("Single chat not found or access denied."), {
      status: 404,
    });
  }

  const agent = await Agent.findByPk(sc.agentId, {
    attributes: ["id", "activeThreadId"],
  });
  if (!agent) {
    throw Object.assign(new Error("Agent not found."), { status: 404 });
  }
  if (agent.activeThreadId) {
    return agent.activeThreadId;
  }
  const threadId = crypto.randomUUID();
  await ensureSession(threadId, null, {
    agentId: agent.id,
  });
  await Agent.update(
    { activeThreadId: threadId },
    { where: { id: agent.id } },
  );
  logger.info("Created canonical thread (single chat)", {
    singleChatId: sid,
    threadId,
    agentId: agent.id,
  });
  return threadId;
}
