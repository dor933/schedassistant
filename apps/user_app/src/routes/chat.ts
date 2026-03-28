import { randomUUID } from "node:crypto";
import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import { GroupMember } from "@scheduling-agent/database";
import { getIO } from "../sockets/server/socketServer";
import { logger } from "../logger";

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";

function parseRequestId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)
    ? raw
    : null;
}

const router = Router();

// ── POST /api/chat ───────────────────────────────────────────────────────────
// Returns 202 immediately. Forwards the request to agent_service which also
// returns 202. The actual reply arrives via the agent_service Socket.IO
// connection → socketClient.ts → fan-out to browser clients.
router.post("/", authMiddleware, (req, res) => {
  const { threadId, message, groupId, singleChatId, agentId, mentionsAgent } = req.body;
  const userId = req.user!.userId;

  if (!threadId || !message) {
    res.status(400).json({ error: "threadId and message are required." });
    return;
  }

  const requestId = parseRequestId(req.body.requestId) ?? randomUUID();

  logger.info("Chat request accepted", { requestId, threadId, userId, groupId, singleChatId, mentionsAgent });

  // Broadcast user message to other group members in real-time
  if (groupId) {
    void (async () => {
      try {
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
            displayName: req.user!.displayName ?? userId,
            message,
            requestId,
          });
        }
      } catch (err) {
        logger.error("Group user-message broadcast error", { groupId, error: String(err) });
      }
    })();
  }

  // Fire-and-forget to agent_service (async, no await)
  void (async () => {
    try {
      const response = await fetch(`${AGENT_SERVICE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          threadId,
          message,
          requestId,
          displayName: req.user!.displayName ?? userId,
          ...(groupId ? { groupId } : {}),
          ...(singleChatId ? { singleChatId } : {}),
          ...(agentId ? { agentId } : {}),
          ...(mentionsAgent != null ? { mentionsAgent } : {}),
        }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        // Agent service rejected the request — emit error directly
        try {
          getIO().to(`user:${userId}`).emit("chat:reply", {
            requestId,
            threadId,
            groupId: groupId ?? null,
            singleChatId: singleChatId ?? null,
            conversationId: groupId ?? singleChatId ?? threadId,
            conversationType: groupId ? "group" : "single",
            ok: false,
            error: typeof data.error === "string" ? data.error : `Agent error (${response.status})`,
          });
        } catch (e) {
          logger.error("Socket emit failed", { error: String(e) });
        }
      }
      // If 202, the reply will come through the agent socket → socketClient handler
    } catch (err: unknown) {
      logger.error("Chat proxy error — agent_service unavailable", { requestId, error: String(err) });
      try {
        getIO().to(`user:${userId}`).emit("chat:reply", {
          requestId,
          threadId,
          groupId: groupId ?? null,
          singleChatId: singleChatId ?? null,
          conversationId: groupId ?? singleChatId ?? threadId,
          conversationType: groupId ? "group" : "single",
          ok: false,
          error: "Agent service unavailable.",
        });
      } catch (e) {
        logger.error("Socket emit failed (error path)", { error: String(e) });
      }
    }
  })();

  res.status(202).json({
    requestId,
    threadId,
    status: "accepted",
  });
});

export { router as chatRouter };
