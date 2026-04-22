import { randomUUID } from "node:crypto";
import path from "node:path";
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

const ATTACHMENT_ALLOWED_EXT = new Set([".md", ".txt"]);
/** Matches the router's multer limit; mirrored here to reject before proxying. */
const ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;

function coerceBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

export class ChatController {
  private chatService = new ChatService();

  send = (req: Request, res: Response) => {
    const { message, groupId, singleChatId, agentId } = req.body;
    const mentionsAgent = coerceBool(req.body.mentionsAgent);
    const userId = req.user!.userId;

    const uploaded = (req as any).file as
      | { originalname: string; buffer: Buffer; size: number; mimetype?: string }
      | undefined;

    if (!message && !uploaded) {
      res.status(400).json({ error: "message or file is required." });
      return;
    }
    if (!groupId && !singleChatId) {
      res.status(400).json({ error: "groupId or singleChatId is required." });
      return;
    }

    let attachment: { fileName: string; content: string } | undefined;
    if (uploaded) {
      const ext = path.extname(uploaded.originalname).toLowerCase();
      if (!ATTACHMENT_ALLOWED_EXT.has(ext)) {
        res.status(400).json({
          error: `Only ${[...ATTACHMENT_ALLOWED_EXT].join(", ")} files are supported.`,
        });
        return;
      }
      if (uploaded.size > ATTACHMENT_MAX_BYTES) {
        res.status(400).json({ error: "File exceeds 2 MB limit." });
        return;
      }
      const fileName = path.basename(uploaded.originalname);
      attachment = {
        fileName,
        content: uploaded.buffer.toString("utf-8"),
      };
    }

    const requestId = parseRequestId(req.body.requestId) ?? randomUUID();

    logger.info("Chat request accepted", {
      requestId,
      userId,
      groupId,
      singleChatId,
      mentionsAgent,
      hasAttachment: !!attachment,
    });

    if (groupId) {
      void this.chatService
        .broadcastUserMessage(
          groupId,
          userId,
          String(req.user!.displayName ?? userId),
          message ?? "",
          requestId,
        )
        .catch((err) =>
          logger.error("Group user-message broadcast error", {
            groupId,
            error: String(err),
          }),
        );
    }

    void this.chatService.proxyToAgentService(
      {
        userId,
        message: message ?? "",
        requestId,
        displayName: req.user!.displayName ?? userId,
        ...(groupId ? { groupId } : {}),
        ...(singleChatId ? { singleChatId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(mentionsAgent != null ? { mentionsAgent } : {}),
        ...(attachment ? { attachment } : {}),
      },
      userId,
      requestId,
      groupId,
      singleChatId,
    );

    res.status(202).json({ requestId, status: "accepted" });
  };
}
