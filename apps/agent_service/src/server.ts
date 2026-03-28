import express from "express";
import cors from "cors";
import type { Queue } from "bullmq";
import { Thread, SingleChat, Group } from "@scheduling-agent/database";
import { ensureSession } from "./memory/sessionRegistry";

import type { AgentChatJobData, AgentChatJobResult } from "./queues/agentChat.bull";
import type { CompiledStateGraph } from "@langchain/langgraph";
import { logger } from "./logger";

export type CreateServerDeps = {
  agentChatQueue: Queue<AgentChatJobData, AgentChatJobResult, string>;
  graph: CompiledStateGraph<any, any, any>;
};

/**
 * Creates and returns the Express app for agent_service.
 * Chat requests are enqueued on `agentChatQueue`; the worker emits results via Socket.IO.
 */
export function createServer({ agentChatQueue, graph }: CreateServerDeps) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // ── POST /api/chat ───────────────────────────────────────────────────
  // Returns 202 immediately. Worker emits the result on Socket.IO (`agent:reply`).
  app.post("/api/chat", async (req, res) => {
    const { userId, threadId, message, groupId, singleChatId, agentId, requestId, mentionsAgent, displayName } = req.body;

    if (!userId || !threadId || !message) {
      return res.status(400).json({ error: "userId, threadId, and message are required." });
    }

    try {
      await agentChatQueue.add(
        "chat",
        {
          userId,
          threadId,
          message,
          requestId: requestId ?? crypto.randomUUID(),
          ...(displayName ? { displayName } : {}),
          ...(groupId != null ? { groupId } : {}),
          ...(singleChatId != null ? { singleChatId } : {}),
          ...(agentId != null ? { agentId } : {}),
          ...(mentionsAgent != null ? { mentionsAgent } : {}),
        } satisfies AgentChatJobData,
      );

      return res.status(202).json({ status: "accepted", threadId });
    } catch (err: any) {
      logger.error("/api/chat enqueue error", { error: err.message });
      return res.status(500).json({ error: err.message ?? "Internal error" });
    }
  });

  // ── GET /api/sessions/:userId ─────────────────────────────────────────
  app.get("/api/sessions/:userId", async (req, res) => {
    try {
      const where: Record<string, unknown> = {};

      // Group threads are shared (userId is null) — look up by groupId only.
      if (req.query.groupId) {
        where.groupId = req.query.groupId;
      } else {
        where.userId = req.params.userId;
        if (req.query.singleChatId) where.singleChatId = req.query.singleChatId;
      }

      const sessions = await Thread.findAll({
        where,
        order: [["updated_at", "DESC"]],
        attributes: ["id", "userId", "groupId", "singleChatId", "title", "createdAt", "updatedAt", "lastActivityAt"],
      });
      // Map id → threadId for client compatibility
      return res.json(sessions.map((s) => ({
        threadId: s.id,
        userId: s.userId,
        groupId: s.groupId,
        singleChatId: s.singleChatId,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        lastActivityAt: s.lastActivityAt,
      })));
    } catch (err: any) {
      logger.error("/api/sessions/:userId error", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/sessions ──────────────────────────────────────────────
  app.post("/api/sessions", async (req, res) => {
    const { userId, title, groupId, singleChatId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId is required." });
    }

    try {
      // Resolve agentId from conversation scope
      let agentId: string | null = null;
      if (singleChatId) {
        const sc = await SingleChat.findByPk(singleChatId, { attributes: ["agentId"] });
        agentId = sc?.agentId ?? null;
      } else if (groupId) {
        const g = await Group.findByPk(groupId, { attributes: ["agentId"] });
        agentId = g?.agentId ?? null;
      }

      const threadId = crypto.randomUUID();
      // Group threads are shared — don't tie them to a specific user.
      const session = await ensureSession(threadId, groupId ? null : userId, {
        groupId: groupId ?? undefined,
        singleChatId: singleChatId ?? undefined,
        agentId,
      });

      if (title) {
        await session.update({ title });
      }

      return res.status(201).json({
        threadId: session.id,
        userId: session.userId,
        groupId: session.groupId,
        singleChatId: session.singleChatId,
        title: session.title,
        createdAt: session.createdAt,
      });
    } catch (err: any) {
      logger.error("POST /api/sessions error", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  /** Transform a raw LangGraph message into a plain HistoryMessage DTO. */
  function toHistoryMessage(m: any) {
    let role: "user" | "assistant" = "user";
    if (typeof m._getType === "function") {
      const t = m._getType();
      role = t === "human" ? "user" : "assistant";
    } else if (m.role === "assistant" || m.role === "ai") {
      role = "assistant";
    }
    const content =
      typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    const senderName = role === "user" ? (m.name ?? null) : null;
    const ak = m.additional_kwargs ?? m.kwargs?.additional_kwargs;
    const modelSlug = role === "assistant" && ak?.modelSlug ? ak.modelSlug : undefined;
    const vendorSlug = role === "assistant" && ak?.vendorSlug ? ak.vendorSlug : undefined;
    const modelName = role === "assistant" && ak?.modelName ? ak.modelName : undefined;
    return {
      role,
      content,
      ...(senderName ? { senderName } : {}),
      ...(modelSlug ? { modelSlug } : {}),
      ...(vendorSlug ? { vendorSlug } : {}),
      ...(modelName ? { modelName } : {}),
    };
  }

  /** Load raw messages from a thread's checkpoint. */
  async function loadRawMessages(threadId: string): Promise<any[]> {
    const state = await graph.getState({
      configurable: { thread_id: threadId },
    });
    if (!state?.values) return [];
    return Array.isArray(state.values.messages) ? state.values.messages : [];
  }

  // ── GET /api/history/:threadId/search ──────────────────────────────
  // (Must be before the generic :threadId route)
  // Returns matching messages with their absolute indices.
  app.get("/api/history/:threadId/search", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    if (!q) return res.json({ results: [], total: 0 });
    try {
      const msgs = await loadRawMessages(req.params.threadId);
      const total = msgs.length;
      const results: { index: number; role: string; content: string; senderName?: string; modelSlug?: string; vendorSlug?: string; modelName?: string }[] = [];

      for (let i = 0; i < msgs.length; i++) {
        const h = toHistoryMessage(msgs[i]);
        if (h.content.toLowerCase().includes(q)) {
          results.push({ index: i, ...h });
        }
      }

      return res.json({ results, total });
    } catch (err: any) {
      logger.error("/api/history/:threadId/search error", { threadId: req.params.threadId, error: err.message });
      return res.json({ results: [], total: 0 });
    }
  });

  // ── GET /api/history/:threadId ─────────────────────────────────────
  // Supports pagination via ?limit=N&offset=M
  // Returns { messages: [...], total: N }
  app.get("/api/history/:threadId", async (req, res) => {
    try {
      const msgs = await loadRawMessages(req.params.threadId);
      const total = msgs.length;

      const limitParam = req.query.limit != null ? Number(req.query.limit) : undefined;
      const offsetParam = req.query.offset != null ? Number(req.query.offset) : undefined;

      let slice: any[];
      if (limitParam != null) {
        // If offset not provided, return the last `limit` messages
        const offset = offsetParam ?? Math.max(0, total - limitParam);
        const end = Math.min(total, offset + limitParam);
        slice = msgs.slice(Math.max(0, offset), end);
      } else {
        slice = msgs;
      }

      const history = slice.map(toHistoryMessage);
      return res.json({ messages: history, total });
    } catch (err: any) {
      logger.error("/api/history/:threadId error", { threadId: req.params.threadId, error: err.message });
      return res.json({ messages: [], total: 0 });
    }
  });

  return app;
}
