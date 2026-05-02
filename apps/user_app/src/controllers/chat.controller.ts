import { randomUUID } from "node:crypto";
import path from "node:path";
import { Request, Response } from "express";
import { ChatService } from "../services/chat.service";
import { organizationSetupService } from "../services/organizationSetup.service";
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

  send = async (req: Request, res: Response) => {
    const { message, groupId, singleChatId, agentId } = req.body;
    const mentionsAgent = coerceBool(req.body.mentionsAgent);
    const userId = req.user!.userId;
    const organizationId = req.user!.organizationId;

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

    // ── Setup gate (slice 15) ─────────────────────────────────────────
    // Refuse chat when the org hasn't finished setup. Embeddings are an
    // invisible dependency (used by episodic RAG on every turn), so a
    // missing config here would otherwise surface as a confusing
    // mid-stream agent_service error. 412 + a structured `missing[]`
    // lets the client render an actionable banner directing the
    // super-admin to the embedding model card.
    try {
      const status = await organizationSetupService.getStatus(organizationId);
      if (!status.complete) {
        res.status(412).json({
          error: "setup_incomplete",
          message:
            "Your organization has not finished setup. " +
            (status.missing.includes("embedding_model")
              ? "Pick an embedding model in Admin → Embedding Model. "
              : "") +
            (status.missing.includes("embedding_key")
              ? `Add an API key for the chosen embedding vendor` +
                (status.embeddingVendorSlug
                  ? ` (${status.embeddingVendorSlug})`
                  : "") +
                ` in Admin → Vendor API Keys.`
              : ""),
          missing: status.missing,
        });
        return;
      }
    } catch (err) {
      logger.error("Setup-status check failed; refusing chat to fail closed", {
        organizationId,
        error: String(err),
      });
      res.status(500).json({ error: "Setup status check failed." });
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
