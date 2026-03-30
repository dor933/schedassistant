import { ConversationMessage } from "@scheduling-agent/database";

export class HistoryService {
  /**
   * Conversation-scoped history — reads from `conversation_messages` table,
   * not from LangGraph checkpoints. Survives thread rotation.
   */
  async getConversationHistory(
    conversationId: string,
    conversationType: "group" | "single",
    query: { limit?: number; offset?: number },
  ) {
    const where =
      conversationType === "group"
        ? { groupId: conversationId }
        : { singleChatId: conversationId };

    const total = await ConversationMessage.count({ where });

    const limit = query.limit ?? total;
    const offset = query.offset ?? Math.max(0, total - limit);

    const rows = await ConversationMessage.findAll({
      where,
      order: [["created_at", "ASC"]],
      offset,
      limit,
    });

    const messages = rows.map((r) => ({
      role: r.role as "user" | "assistant",
      content: r.content,
      ...(r.senderName ? { senderName: r.senderName } : {}),
      ...(r.modelSlug ? { modelSlug: r.modelSlug } : {}),
      ...(r.vendorSlug ? { vendorSlug: r.vendorSlug } : {}),
      ...(r.modelName ? { modelName: r.modelName } : {}),
    }));

    return { messages, total };
  }

  /**
   * Search within `conversation_messages` for one group or single chat.
   * Indices match the chronological order used by `getConversationHistory` (ASC by `created_at`).
   */
  async searchConversationHistory(
    conversationId: string,
    conversationType: "group" | "single",
    q: string,
  ) {
    const needle = q.trim().toLowerCase();
    if (!needle) return { results: [], total: 0 };

    const where =
      conversationType === "group"
        ? { groupId: conversationId }
        : { singleChatId: conversationId };

    const rows = await ConversationMessage.findAll({
      where,
      order: [["created_at", "ASC"]],
      attributes: ["role", "content", "senderName", "modelSlug", "vendorSlug", "modelName"],
    });

    const results: {
      index: number;
      role: string;
      content: string;
      senderName?: string;
      modelSlug?: string;
      vendorSlug?: string;
      modelName?: string;
    }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const text = (r.content ?? "").toLowerCase();
      if (!text.includes(needle)) continue;
      results.push({
        index: i,
        role: r.role as string,
        content: r.content,
        ...(r.senderName ? { senderName: r.senderName } : {}),
        ...(r.modelSlug ? { modelSlug: r.modelSlug } : {}),
        ...(r.vendorSlug ? { vendorSlug: r.vendorSlug } : {}),
        ...(r.modelName ? { modelName: r.modelName } : {}),
      });
    }

    return { results, total: rows.length };
  }
}
