import crypto from "node:crypto";
import {
  Roundtable,
  RoundtableAgent,
  RoundtableMessage,
  Agent,
} from "@scheduling-agent/database";
import type { UserId } from "@scheduling-agent/types";
import { logger } from "../../logger";

const AGENT_SERVICE_URL =
  process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";

export class RoundtableService {
  async getAll(userId: UserId) {
    return Roundtable.findAll({
      where: { createdBy: userId },
      order: [["createdAt", "DESC"]],
    });
  }

  async getById(roundtableId: string) {
    const roundtable = await Roundtable.findByPk(roundtableId);
    if (!roundtable) return null;

    const agents = await RoundtableAgent.findAll({
      where: { roundtableId },
      order: [["turnOrder", "ASC"]],
      include: [{ association: "agent", attributes: ["definition", "agentName"] }],
    });

    const messages = await RoundtableMessage.findAll({
      where: { roundtableId },
      order: [["createdAt", "ASC"]],
      include: [{ association: "agent", attributes: ["definition", "agentName"] }],
    });

    return {
      ...roundtable.toJSON(),
      agents: agents.map((ra) => ({
        id: ra.id,
        agentId: ra.agentId,
        turnOrder: ra.turnOrder,
        turnsCompleted: ra.turnsCompleted,
        agentName: (ra as any).agent?.agentName || (ra as any).agent?.definition || ra.agentId,
      })),
      messages: messages.map((m) => ({
        id: m.id,
        agentId: m.agentId,
        agentName: (m as any).agent?.agentName || (m as any).agent?.definition || m.agentId,
        roundNumber: m.roundNumber,
        content: m.content,
        createdAt: m.createdAt,
      })),
    };
  }

  async create(
    userId: UserId,
    topic: string,
    agentIds: string[],
    maxTurnsPerAgent: number = 5,
    groupId?: string | null,
    singleChatId?: string | null,
  ) {
    if (!topic?.trim()) {
      throw Object.assign(new Error("topic is required"), { status: 400 });
    }
    if (!agentIds || agentIds.length < 2) {
      throw Object.assign(new Error("At least 2 agents are required"), { status: 400 });
    }

    // Verify all agents exist
    const agents = await Agent.findAll({
      where: { id: agentIds },
      attributes: ["id", "definition", "agentName"],
    });
    if (agents.length !== agentIds.length) {
      const found = new Set(agents.map((a) => a.id));
      const missing = agentIds.filter((id) => !found.has(id));
      throw Object.assign(
        new Error(`Agent(s) not found: ${missing.join(", ")}`),
        { status: 400 },
      );
    }

    const threadId = crypto.randomUUID();

    const roundtable = await Roundtable.create({
      topic: topic.trim(),
      maxTurnsPerAgent,
      threadId,
      createdBy: userId,
      groupId: groupId ?? null,
      singleChatId: singleChatId ?? null,
    });

    // Create agent entries preserving the order from the request
    for (let i = 0; i < agentIds.length; i++) {
      await RoundtableAgent.create({
        roundtableId: roundtable.id,
        agentId: agentIds[i],
        turnOrder: i,
      });
    }

    // Notify agent_service to enqueue the first turn
    const firstAgentId = agentIds[0];
    try {
      const res = await fetch(`${AGENT_SERVICE_URL}/api/roundtable/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roundtableId: roundtable.id,
          agentId: firstAgentId,
          userId,
          groupId: groupId ?? null,
          singleChatId: singleChatId ?? null,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        logger.error("Failed to start roundtable on agent_service", {
          roundtableId: roundtable.id,
          status: res.status,
          error: (data as any)?.error,
        });
        await Roundtable.update(
          { status: "failed" },
          { where: { id: roundtable.id } },
        );
        throw new Error("Failed to start roundtable on agent service");
      }
    } catch (err: any) {
      if (err.message === "Failed to start roundtable on agent service") throw err;
      logger.error("Agent service unreachable for roundtable start", {
        roundtableId: roundtable.id,
        error: err?.message,
      });
      await Roundtable.update(
        { status: "failed" },
        { where: { id: roundtable.id } },
      );
      throw new Error("Agent service is unreachable");
    }

    return { id: roundtable.id, threadId, status: "pending" };
  }

  async stop(roundtableId: string, userId: UserId) {
    const roundtable = await Roundtable.findByPk(roundtableId);
    if (!roundtable) {
      throw Object.assign(new Error("Roundtable not found"), { status: 404 });
    }
    if (roundtable.createdBy !== userId) {
      throw Object.assign(new Error("Not authorized"), { status: 403 });
    }
    if (roundtable.status !== "running" && roundtable.status !== "pending") {
      throw Object.assign(
        new Error(`Cannot stop roundtable with status "${roundtable.status}"`),
        { status: 400 },
      );
    }

    try {
      await fetch(`${AGENT_SERVICE_URL}/api/roundtable/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roundtableId }),
      });
    } catch {
      // Best effort — update locally anyway
    }

    await Roundtable.update(
      { status: "completed" },
      { where: { id: roundtableId } },
    );

    return { ok: true };
  }
}
