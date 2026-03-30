import { GroupMember } from "@scheduling-agent/database";
import { getIO } from "../sockets/server/socketServer";
import { logger } from "../logger";

const AGENT_SERVICE_URL =
  process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";

export class ChatService {
  async broadcastUserMessage(
    groupId: string,
    userId: string,
    displayName: string,
    message: string,
    requestId: string,
  ) {
    const members = await GroupMember.findAll({
      where: { groupId },
      attributes: ["userId"],
    });
    const browserIO = getIO();
    for (const m of members) {
      if (m.userId === userId) continue;
      browserIO.to(`user:${m.userId}`).emit("group:user-message", {
        groupId,
        userId,
        displayName,
        message,
        requestId,
      });
    }
  }

  async proxyToAgentService(
    payload: Record<string, unknown>,
    userId: string,
    requestId: string,
    threadId: string,
    groupId?: string,
    singleChatId?: string,
  ) {
    try {
      const response = await fetch(`${AGENT_SERVICE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        this.emitError(
          userId,
          requestId,
          threadId,
          groupId,
          singleChatId,
          typeof data.error === "string"
            ? data.error
            : `Agent error (${response.status})`,
        );
      }
    } catch (err: unknown) {
      logger.error("Chat proxy error — agent_service unavailable", {
        requestId,
        error: String(err),
      });
      this.emitError(
        userId,
        requestId,
        threadId,
        groupId,
        singleChatId,
        "Agent service unavailable.",
      );
    }
  }

  private emitError(
    userId: string,
    requestId: string,
    threadId: string,
    groupId?: string,
    singleChatId?: string,
    error?: string,
  ) {
    try {
      getIO()
        .to(`user:${userId}`)
        .emit("chat:reply", {
          requestId,
          threadId,
          groupId: groupId ?? null,
          singleChatId: singleChatId ?? null,
          conversationId: groupId ?? singleChatId ?? threadId,
          conversationType: groupId ? "group" : "single",
          ok: false,
          error: error ?? "Unknown error",
        });
    } catch (e) {
      logger.error("Socket emit failed", { error: String(e) });
    }
  }
}
