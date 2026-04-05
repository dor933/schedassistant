import {
  SingleChat, ConversationMessage, MessageNotification
} from "@scheduling-agent/database";
import type { UserId } from "@scheduling-agent/types";
import { logger } from "../logger";

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";

export class SessionsService {
  private async assertConversationAccess(
    userId: UserId,
    conversationType: string,
    conversationId: string,
  ): Promise<void> {
    if (conversationType === "single") {
      const sc = await SingleChat.findOne({ where: { id: conversationId, userId } });
      if (!sc) {
        throw Object.assign(new Error("Conversation not found."), { status: 404 });
      }
      return;
    }
    throw Object.assign(new Error("Invalid conversation type."), { status: 400 });
  }

  async getSessions(userId: UserId, singleChatId?: string) {
    const params = new URLSearchParams();
    if (singleChatId) params.set("singleChatId", singleChatId);
    const qs = params.toString();
    const url = `${AGENT_SERVICE_URL}/api/sessions/${userId}${qs ? `?${qs}` : ""}`;
    const response = await fetch(url);
    return response.json();
  }

  async createSession(userId: UserId, title?: string, singleChatId?: string) {
    const response = await fetch(`${AGENT_SERVICE_URL}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        title,
        ...(singleChatId ? { singleChatId } : {}),
      }),
    });
    const data: any = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error ?? "Session creation failed"), { status: response.status, data });
    return data;
  }

  async getConversationHistory(
    userId: UserId,
    conversationType: string,
    conversationId: string,
    limit?: string,
    offset?: string,
  ) {
    await this.assertConversationAccess(userId, conversationType, conversationId);
    const params = new URLSearchParams();
    if (limit) params.set("limit", limit);
    if (offset) params.set("offset", offset);
    const qs = params.toString();
    const response = await fetch(
      `${AGENT_SERVICE_URL}/api/history/conversation/${conversationType}/${conversationId}${qs ? `?${qs}` : ""}`,
    );
    return response.json();
  }

  async searchConversationHistory(userId: UserId, conversationType: string, conversationId: string, q?: string) {
    await this.assertConversationAccess(userId, conversationType, conversationId);
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    const qs = params.toString();
    const response = await fetch(
      `${AGENT_SERVICE_URL}/api/history/conversation/${conversationType}/${conversationId}/search?${qs}`,
    );
    return response.json();
  }

  async deleteSingleChat(scId: string, userId: UserId) {
    const sc = await SingleChat.findByPk(scId);
    if (!sc) throw Object.assign(new Error("Single chat not found."), { status: 404 });
    if (sc.userId !== userId) throw Object.assign(new Error("You can only delete your own chats."), { status: 403 });

    // Clear conversation messages and notifications only — keep the
    // agent↔user pair (SingleChat row) permanent.
    await ConversationMessage.destroy({ where: { singleChatId: scId } });
    await MessageNotification.destroy({ where: { conversationId: scId, conversationType: "single" } });

    logger.info("Single chat conversation cleared", { scId, userId });
    return { cleared: true };
  }
}
