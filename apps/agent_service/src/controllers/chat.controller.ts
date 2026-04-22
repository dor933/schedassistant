import { Request, Response } from "express";
import { ChatService } from "../services/chat.service";
import { logger } from "../logger";

const chatService = new ChatService();

export class ChatController {
  send = async (req: Request, res: Response) => {
    const {
      userId,
      message,
      groupId,
      singleChatId,
      agentId,
      requestId,
      mentionsAgent,
      displayName,
      attachment,
    } = req.body;

    if (!userId || (!message && !attachment)) {
      return res
        .status(400)
        .json({ error: "userId and message (or attachment) are required." });
    }
    if (!groupId && !singleChatId) {
      return res
        .status(400)
        .json({ error: "groupId or singleChatId is required." });
    }

    // Validate attachment shape if present.
    let validatedAttachment:
      | { fileName: string; content: string }
      | undefined;
    if (attachment != null) {
      const fileName =
        typeof attachment?.fileName === "string" ? attachment.fileName : "";
      const content =
        typeof attachment?.content === "string" ? attachment.content : "";
      if (!fileName || !content) {
        return res.status(400).json({
          error: "attachment must include non-empty fileName and content.",
        });
      }
      validatedAttachment = { fileName, content };
    }

    try {
      const resolvedRequestId = await chatService.enqueueChat({
        userId,
        message: message ?? "",
        requestId,
        displayName,
        groupId,
        singleChatId,
        agentId,
        mentionsAgent,
        ...(validatedAttachment ? { attachment: validatedAttachment } : {}),
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
