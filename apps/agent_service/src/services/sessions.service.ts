import { Agent, Group, SingleChat, Thread } from "@scheduling-agent/database";
import type { UserId } from "@scheduling-agent/types";
import { ensureCanonicalThreadId } from "../sessionsManagment/canonicalThread";
import { logger } from "../logger";

export class SessionsService {
  async getSessions(
    userId: UserId,
    query: { groupId?: string; singleChatId?: string },
  ) {
    const attributes = [
      "id",
      "userId",
      "title",
      "createdAt",
      "updatedAt",
      "lastActivityAt",
    ] as const;

    if (query.groupId) {
      const g = await Group.findByPk(query.groupId, {
        attributes: ["agentId"],
      });
      if (!g?.agentId) return [];
      const sessions = await Thread.findAll({
        where: { agentId: g.agentId },
        order: [["updated_at", "DESC"]],
        attributes: [...attributes],
      });
      return this.mapSessions(sessions, { groupId: query.groupId });
    }

    if (query.singleChatId) {
      const owned = await SingleChat.findOne({
        where: { id: query.singleChatId, userId },
        attributes: ["agentId"],
      });
      if (!owned?.agentId) return [];
      const agent = await Agent.findByPk(owned.agentId, {
        attributes: ["activeThreadId"],
      });
      if (!agent?.activeThreadId) return [];
      const sessions = await Thread.findAll({
        where: { id: agent.activeThreadId },
        order: [["updated_at", "DESC"]],
        attributes: [...attributes],
      });
      return this.mapSessions(sessions, { singleChatId: query.singleChatId });
    }

    const sessions = await Thread.findAll({
      where: { userId },
      order: [["updated_at", "DESC"]],
      attributes: [...attributes],
    });
    return this.mapSessions(sessions, {});
  }

  private mapSessions(
    sessions: Thread[],
    scope: { groupId?: string; singleChatId?: string },
  ) {
    return sessions.map((s) => ({
      threadId: s.id,
      userId: s.userId,
      groupId: scope.groupId ?? null,
      singleChatId: scope.singleChatId ?? null,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      lastActivityAt: s.lastActivityAt,
    }));
  }

  /**
   * Ensures a LangGraph thread exists for the group or single chat (`ensureCanonicalThreadId`).
   * Idempotent with chat enqueue.
   */
  async createSession(data: {
    userId: UserId;
    title?: string;
    groupId?: string;
    singleChatId?: string;
  }) {
    const threadId = await ensureCanonicalThreadId({
      userId: data.userId,
      groupId: data.groupId ?? null,
      singleChatId: data.singleChatId ?? null,
    });

    if (data.title) {
      await Thread.update({ title: data.title }, { where: { id: threadId } });
    }

    logger.info("Session ensured", {
      threadId,
      groupId: data.groupId ?? null,
      singleChatId: data.singleChatId ?? null,
    });

    return { ok: true as const };
  }
}
