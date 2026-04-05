import type { UserId } from "@scheduling-agent/types";
import { getIO } from "../sockets/server/socketServer";
import { logger } from "../logger";

const AGENT_SERVICE_URL =
  process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";

export class ChatService {
  async proxyToAgentService(
    payload: Record<string, unknown>,
    userId: UserId,
    requestId: string,
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
        singleChatId,
        "Agent service unavailable.",
      );
    }
  }

  private emitError(
    userId: UserId,
    requestId: string,
    singleChatId: string | undefined,
    error?: string,
  ) {
    try {
      const conversationId = singleChatId ?? "";
      getIO()
        .to(`user:${userId}`)
        .emit("chat:reply", {
          requestId,
          threadId: "",
          singleChatId: singleChatId ?? null,
          conversationId,
          conversationType: "single",
          ok: false,
          error: error ?? "Unknown error",
        });
    } catch (e) {
      logger.error("Socket emit failed", { error: String(e) });
    }
  }
}
