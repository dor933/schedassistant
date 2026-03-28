import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import { logger } from "../logger";
import {
  SingleChat,
  Agent,
  Thread,
  EpisodicMemory,
  GroupMember,
  User,
  sequelize,
} from "@scheduling-agent/database";
import { Op } from "sequelize";

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";

const router = Router();

// ── GET /api/sessions ────────────────────────────────────────────────────────
router.get("/", authMiddleware, async (req, res) => {
  const userId = req.user!.userId;
  const { groupId, singleChatId } = req.query;

  try {
    const params = new URLSearchParams();
    if (typeof groupId === "string") params.set("groupId", groupId);
    if (typeof singleChatId === "string") params.set("singleChatId", singleChatId);
    const qs = params.toString();
    const url = `${AGENT_SERVICE_URL}/api/sessions/${userId}${qs ? `?${qs}` : ""}`;
    const response = await fetch(url);
    const data = await response.json();
    return res.json(data);
  } catch (err: any) {
    logger.error("Sessions proxy error", { error: err?.message });
    return res.status(502).json({ error: "Agent service unavailable." });
  }
});

// ── POST /api/sessions ───────────────────────────────────────────────────────
router.post("/", authMiddleware, async (req, res) => {
  const userId = req.user!.userId;
  const { title, groupId, singleChatId } = req.body;

  try {
    const response = await fetch(`${AGENT_SERVICE_URL}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        title,
        ...(groupId ? { groupId } : {}),
        ...(singleChatId ? { singleChatId } : {}),
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.status(201).json(data);
  } catch (err: any) {
    logger.error("Sessions proxy error", { error: err?.message });
    return res.status(502).json({ error: "Agent service unavailable." });
  }
});

// ── GET /api/sessions/history/:threadId/search ───────────────────────────────
// (Must be before the generic :threadId route)
router.get("/history/:threadId/search", authMiddleware, async (req, res) => {
  try {
    const params = new URLSearchParams();
    if (req.query.q) params.set("q", String(req.query.q));
    const response = await fetch(
      `${AGENT_SERVICE_URL}/api/history/${req.params.threadId}/search?${params}`,
    );
    const data = await response.json();
    return res.json(data);
  } catch (err: any) {
    logger.error("Search proxy error", { error: err?.message });
    return res.status(502).json({ error: "Agent service unavailable." });
  }
});

// ── GET /api/sessions/history/:threadId ───────────────────────────────────────
router.get("/history/:threadId", authMiddleware, async (req, res) => {
  try {
    const params = new URLSearchParams();
    if (req.query.limit) params.set("limit", String(req.query.limit));
    if (req.query.offset) params.set("offset", String(req.query.offset));
    const qs = params.toString();
    const response = await fetch(
      `${AGENT_SERVICE_URL}/api/history/${req.params.threadId}${qs ? `?${qs}` : ""}`,
    );
    const data = await response.json();
    return res.json(data);
  } catch (err: any) {
    logger.error("History proxy error", { error: err?.message });
    return res.status(502).json({ error: "Agent service unavailable." });
  }
});

// ── GET /api/sessions/agents — list unattached agents (available for new chats) ──
router.get("/agents", authMiddleware, async (_req, res) => {
  try {
    const agents = await Agent.findAll({
      where: { singleChatId: null, groupId: null },
      attributes: ["id", "definition"],
      order: [["created_at", "ASC"]],
    });
    return res.json(agents);
  } catch (err: any) {
    logger.error("GET /agents error", { error: err?.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/sessions/single-chats — create a new single chat ──────────────
router.post("/single-chats", authMiddleware, async (req, res) => {
  const userId = req.user!.userId;
  const { agentId } = req.body;

  if (!agentId) {
    return res.status(400).json({ error: "agentId is required." });
  }

  try {
    const agent = await Agent.findByPk(agentId, { attributes: ["id", "definition", "singleChatId", "groupId"] });
    if (!agent) {
      return res.status(404).json({ error: "Agent not found." });
    }

    // Validate agent is unattached (exclusive assignment)
    if (agent.singleChatId || agent.groupId) {
      return res.status(409).json({ error: "This agent is already attached to another conversation." });
    }

    const sc = await SingleChat.create({
      userId,
      agentId,
      title: agent.definition || "Agent Chat",
    });

    // Link the agent to this single chat
    await agent.update({ singleChatId: sc.id });

    return res.status(201).json({
      id: sc.id,
      agentId: sc.agentId,
      title: sc.title,
      model: null,
    });
  } catch (err: any) {
    logger.error("POST /single-chats error", { error: err?.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/sessions/single-chats/:id — delete with full cascade ─────────
router.delete("/single-chats/:id", authMiddleware, async (req, res) => {
  const userId = req.user!.userId;
  const scId = req.params.id as string;

  try {
    const sc = await SingleChat.findByPk(scId);
    if (!sc) return res.status(404).json({ error: "Single chat not found." });
    if (sc.userId !== userId) {
      return res.status(403).json({ error: "You can only delete your own chats." });
    }

    // Prevent deleting if it's the user's only single chat
    const chatCount = await SingleChat.count({ where: { userId } });
    if (chatCount <= 1) {
      return res.status(403).json({ error: "You cannot delete your last remaining chat." });
    }

    // Find all threads for this single chat
    const threads = await Thread.findAll({
      where: { singleChatId: scId },
      attributes: ["id"],
    });
    const threadIds = threads.map((t) => t.id);

    // Delete in a transaction
    await sequelize.transaction(async (t) => {
      if (threadIds.length > 0) {
        // Delete episodic memory chunks linked to these threads
        await EpisodicMemory.destroy({
          where: { threadId: { [Op.in]: threadIds } },
          transaction: t,
        });

        // Delete checkpoint data (blobs + writes + checkpoints)
        for (const tid of threadIds) {
          await sequelize.query(
            `DELETE FROM checkpoint_blobs WHERE thread_id = :tid`,
            { replacements: { tid }, transaction: t },
          );
          await sequelize.query(
            `DELETE FROM checkpoint_writes WHERE thread_id = :tid`,
            { replacements: { tid }, transaction: t },
          );
          await sequelize.query(
            `DELETE FROM checkpoints WHERE thread_id = :tid`,
            { replacements: { tid }, transaction: t },
          );
        }

        // Delete threads
        await Thread.destroy({
          where: { singleChatId: scId },
          transaction: t,
        });
      }

      // Delete the single chat itself
      await sc.destroy({ transaction: t });
    });

    // Unlink the agent so it becomes available again
    await Agent.update({ singleChatId: null }, { where: { singleChatId: scId } });

    logger.info("Single chat deleted with cascade", { scId, userId, threadCount: threadIds.length });

    return res.json({ deleted: true });
  } catch (err: any) {
    logger.error("DELETE /single-chats error", { error: err?.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/sessions/groups/:groupId/members — public group member list ─────
router.get("/groups/:groupId/members", authMiddleware, async (req, res) => {
  const userId = req.user!.userId;
  const { groupId } = req.params;

  try {
    // Verify the requesting user is a member of this group
    const membership = await GroupMember.findOne({ where: { groupId, userId } });
    if (!membership) {
      return res.status(403).json({ error: "You are not a member of this group." });
    }

    const members = await GroupMember.findAll({
      where: { groupId },
      attributes: ["userId"],
    });

    const userIds = members.map((m) => m.userId);
    const users = await User.findAll({
      where: { id: userIds },
      attributes: ["id", "displayName"],
    });

    const userMap = Object.fromEntries(users.map((u) => [u.id, u.displayName]));

    const result = userIds.map((id) => ({
      userId: id,
      displayName: userMap[id] ?? null,
    }));

    return res.json(result);
  } catch (err: any) {
    logger.error("GET /groups/:groupId/members error", { error: err?.message });
    return res.status(500).json({ error: err.message });
  }
});

export { router as sessionsRouter };
