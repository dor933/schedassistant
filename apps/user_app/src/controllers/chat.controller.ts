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
    const { message, singleChatId, agentId, mentionsAgent } =
      req.body;
    const userId = req.user!.userId;

    if (!message) {
      res.status(400).json({ error: "message is required." });
      return;
    }
    if (!singleChatId) {
      res.status(400).json({ error: "singleChatId is required." });
      return;
    }

    const requestId = parseRequestId(req.body.requestId) ?? randomUUID();

    logger.info("Chat request accepted", {
      requestId,
      userId,
      singleChatId,
      mentionsAgent,
    });

    void this.chatService.proxyToAgentService(
      {
        userId,
        message,
        requestId,
        displayName: req.user!.displayName ?? userId,
        singleChatId,
        ...(agentId ? { agentId } : {}),
        ...(mentionsAgent != null ? { mentionsAgent } : {}),
      },
      userId,
      requestId,
      singleChatId,
    );

    res.status(202).json({ requestId, status: "accepted" });
  };
}
