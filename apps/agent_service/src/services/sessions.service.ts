import crypto from "node:crypto";
import { Thread, SingleChat, Group, Agent } from "@scheduling-agent/database";
import { ensureSession } from "../sessionsManagment/sessionRegistry";
import { logger } from "../logger";

export class SessionsService {
  async getSessions(userId: string, query: { groupId?: string; singleChatId?: string }) {
    const attributes = [
      "id",
      "userId",
      "title",
      "createdAt",
      "updatedAt",
      "lastActivityAt",
    ] as const;

    if (query.groupId) {
      const g = await Group.findByPk(query.groupId, { attributes: ["agentId"] });
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
        attributes: ["activeThreadId"],
      });
      if (!owned?.activeThreadId) return [];
      const sessions = await Thread.findAll({
        where: { id: owned.activeThreadId },
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
   * Pool agents (`group_id` IS NULL): reuse `agents.active_thread_id` for every user’s
   * `single_chat` so LangGraph state is one thread per agent. Group chats unchanged.
   */
  async createSession(data: { userId: string; title?: string; groupId?: string; singleChatId?: string }) {
    let agentId: string | null = null;

    if (data.singleChatId) {
      const sc = await SingleChat.findOne({
        where: { id: data.singleChatId, userId: data.userId },
        attributes: ["agentId"],
      });
      if (!sc) {
        throw Object.assign(new Error("Single chat not found or access denied."), { status: 404 });
      }
      agentId = sc.agentId;

      const agent = await Agent.findByPk(agentId, { attributes: ["activeThreadId", "groupId"] });
      if (agent?.groupId) {
        throw Object.assign(new Error("This agent is bound to a group."), { status: 409 });
      }

      const threadId = agent?.activeThreadId ?? crypto.randomUUID();
      const isNewCanonical = !agent?.activeThreadId;

      const session = await ensureSession(threadId, null, {
        agentId,
      });

      await SingleChat.update({ activeThreadId: threadId }, { where: { id: data.singleChatId } });
      if (isNewCanonical) {
        await Agent.update({ activeThreadId: threadId }, { where: { id: agentId } });
      }

      if (data.title) {
        await session.update({ title: data.title });
      }

      logger.info("Session ensured (single chat / pool agent)", {
        threadId,
        singleChatId: data.singleChatId,
        agentId,
        reused: !isNewCanonical,
      });

      return {
        threadId: session.id,
        userId: session.userId,
        groupId: null as string | null,
        singleChatId: data.singleChatId,
        title: session.title,
        createdAt: session.createdAt,
      };
    }

    if (data.groupId) {
      const g = await Group.findByPk(data.groupId, { attributes: ["agentId"] });
      agentId = g?.agentId ?? null;
    }

    const threadId = crypto.randomUUID();
    const session = await ensureSession(threadId, data.groupId ? null : data.userId, {
      agentId,
    });

    if (data.groupId) {
      await Group.update({ activeThreadId: threadId }, { where: { id: data.groupId } });
    }

    if (data.title) {
      await session.update({ title: data.title });
    }

    return {
      threadId: session.id,
      userId: session.userId,
      groupId: data.groupId ?? null,
      singleChatId: null as string | null,
      title: session.title,
      createdAt: session.createdAt,
    };
  }
}
