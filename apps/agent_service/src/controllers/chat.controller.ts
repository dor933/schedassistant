import { Request, Response } from "express";
import { ChatService } from "../services/chat.service";
import { logger } from "../logger";

const chatService = new ChatService();

export class ChatController {
  send = async (req: Request, res: Response) => {
    const {
      userId,
      message,
      singleChatId,
      agentId,
      requestId,
      mentionsAgent,
      displayName,
    } = req.body;

    if (!userId || !message) {
      return res.status(400).json({ error: "userId and message are required." });
    }
    if (!singleChatId) {
      return res
        .status(400)
        .json({ error: "singleChatId is required." });
    }

    try {
      const resolvedRequestId = await chatService.enqueueChat({
        userId,
        message,
        requestId,
        displayName,
        singleChatId,
        agentId,
        mentionsAgent,
      });

      return res.status(202).json({
        status: "accepted",
        requestId: resolvedRequestId,
      });
    } catch (err: any) {
      logger.error("/api/chat enqueue error", { error: err.message });
      return res.status(500).json({ error: err.message ?? "Internal error" });
    }
  };
}
