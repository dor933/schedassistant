import { randomUUID } from "node:crypto";
import { Request, Response } from "express";
import { ChatService } from "../services/chat.service";
import { logger } from "../logger";

function parseRequestId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    raw,
  )
    ? raw
    : null;
}

export class ChatController {
  private chatService = new ChatService();

  send = (req: Request, res: Response) => {
    const { threadId, message, groupId, singleChatId, agentId, mentionsAgent } =
      req.body;
    const userId = req.user!.userId;

    if (!threadId || !message) {
      res.status(400).json({ error: "threadId and message are required." });
      return;
    }

    const requestId = parseRequestId(req.body.requestId) ?? randomUUID();

    logger.info("Chat request accepted", {
      requestId,
      threadId,
      userId,
      groupId,
      singleChatId,
      mentionsAgent,
    });

    // Broadcast user message to other group members in real-time
    if (groupId) {
      void this.chatService
        .broadcastUserMessage(
          groupId,
          userId,
          req.user!.displayName ?? userId,
          message,
          requestId,
        )
        .catch((err) =>
          logger.error("Group user-message broadcast error", {
            groupId,
            error: String(err),
          }),
        );
    }

    // Fire-and-forget to agent_service
    void this.chatService.proxyToAgentService(
      {
        userId,
        threadId,
        message,
        requestId,
        displayName: req.user!.displayName ?? userId,
        ...(groupId ? { groupId } : {}),
        ...(singleChatId ? { singleChatId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(mentionsAgent != null ? { mentionsAgent } : {}),
      },
      userId,
      requestId,
      threadId,
      groupId,
      singleChatId,
    );

    res.status(202).json({ requestId, threadId, status: "accepted" });
  };
}
