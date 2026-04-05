import { SingleChat } from "@scheduling-agent/database";
import type { UserId } from "@scheduling-agent/types";
import { logger } from "../logger";

/**
 * Sessions service — after the deep-agent refactor, a "session" is just the
 * single_chat itself. The LangGraph `thread_id` is equal to `single_chat.id`,
 * so this service is a thin compatibility shim over the `single_chats` table.
 */
export class SessionsService {
  async getSessions(
    userId: UserId,
    query: { singleChatId?: string },
  ) {
    if (query.singleChatId) {
      const sc = await SingleChat.findOne({
        where: { id: query.singleChatId, userId },
        attributes: ["id", "title", "createdAt", "updatedAt"],
      });
      if (!sc) return [];
      return [this.toSession(sc)];
    }

    const rows = await SingleChat.findAll({
      where: { userId },
      order: [["updated_at", "DESC"]],
      attributes: ["id", "title", "createdAt", "updatedAt"],
    });
    return rows.map((sc) => this.toSession(sc));
  }

  private toSession(sc: SingleChat) {
    return {
      threadId: sc.id,
      singleChatId: sc.id,
      userId: null as number | null,
      title: sc.title,
      createdAt: sc.createdAt,
      updatedAt: sc.updatedAt,
      lastActivityAt: sc.updatedAt,
    };
  }

  /**
   * Idempotent "ensure this single chat has a session" — after the refactor,
   * this is a no-op: the single_chat.id IS the LangGraph thread id and the
   * single_chat row is created when the user/agent pair first appears.
   */
  async createSession(data: {
    userId: UserId;
    title?: string;
    singleChatId?: string;
  }) {
    if (!data.singleChatId) {
      return { ok: true as const };
    }

    if (data.title) {
      await SingleChat.update(
        { title: data.title },
        { where: { id: data.singleChatId, userId: data.userId } },
      );
    }

    logger.info("Session ensured (single_chat)", {
      singleChatId: data.singleChatId,
    });

    return { ok: true as const };
  }
}
