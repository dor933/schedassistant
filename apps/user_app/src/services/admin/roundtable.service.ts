import crypto from "node:crypto";
import {
  Roundtable,
  RoundtableAgent,
  RoundtableUser,
  RoundtableMessage,
  Agent,
  User,
} from "@scheduling-agent/database";
import type { UserId } from "@scheduling-agent/types";
import { logger } from "../../logger";
import { InAppNotificationsService } from "../inAppNotifications.service";

const AGENT_SERVICE_URL =
  process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";

/**
 * Mirror of `USER_TURN_TIMEOUT_SECONDS` in the agent_service worker —
 * the worker is the actual enforcer (it emits `roundtable:user_turn`
 * with this `deadlineSeconds`). The value here only feeds the
 * `userTurnDeadlineAt` field on the GET /roundtables/:id response so a
 * page refresh can recompute the same deadline without waiting for a
 * fresh socket event. Keep both numbers in lockstep.
 */
const USER_TURN_TIMEOUT_SECONDS = 5 * 60;

export class RoundtableService {
  private notifications = new InAppNotificationsService();

  async getAll(userId: UserId) {
    const participantRows = await RoundtableUser.findAll({
      where: { userId },
      attributes: ["roundtableId"],
    });
    const participantIds = participantRows.map((r) => r.roundtableId);

    const asCreator = await Roundtable.findAll({
      where: { createdBy: userId },
      order: [["createdAt", "DESC"]],
    });

    let asParticipant: Roundtable[] = [];
    if (participantIds.length > 0) {
      asParticipant = await Roundtable.findAll({
        where: { id: participantIds },
        order: [["createdAt", "DESC"]],
      });
    }

    const seen = new Set<string>();
    const merged = [...asCreator, ...asParticipant].filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    merged.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return merged;
  }

  async getById(roundtableId: string) {
    const roundtable = await Roundtable.findByPk(roundtableId);
    if (!roundtable) return null;

    const agents = await RoundtableAgent.findAll({
      where: { roundtableId },
      order: [["turnOrder", "ASC"]],
      include: [{ association: "agent", attributes: ["definition", "agentName"] }],
    });

    const users = await RoundtableUser.findAll({
      where: { roundtableId },
      order: [["turnOrder", "ASC"]],
      include: [{ association: "user", attributes: ["id", "displayName"] }],
    });

    const messages = await RoundtableMessage.findAll({
      where: { roundtableId },
      order: [["createdAt", "ASC"]],
      include: [
        { association: "agent", attributes: ["definition", "agentName"] },
        { association: "user", attributes: ["id", "displayName"] },
      ],
    });

    // When status === "waiting_for_user", the active turn belongs to the
    // first participant whose `turnsCompleted <= currentRound` in
    // `turn_order`. Surfacing both the userId and an absolute deadline
    // here lets the client render the right "Your turn" / "Waiting for X"
    // banner on a fresh page load without re-deriving the answer from a
    // brittle find() heuristic, and without resetting the 5-minute timer.
    const activeUserTurnRow =
      roundtable.status === "waiting_for_user"
        ? users.find((u) => u.turnsCompleted <= roundtable.currentRound) ?? null
        : null;
    const userTurnStartedAtIso = roundtable.userTurnStartedAt
      ? roundtable.userTurnStartedAt.toISOString()
      : null;
    const userTurnDeadlineAtIso = roundtable.userTurnStartedAt
      ? new Date(
          roundtable.userTurnStartedAt.getTime() +
            USER_TURN_TIMEOUT_SECONDS * 1000,
        ).toISOString()
      : null;

    return {
      ...roundtable.toJSON(),
      userTurnStartedAt: userTurnStartedAtIso,
      userTurnDeadlineAt: userTurnDeadlineAtIso,
      currentTurnUserId: activeUserTurnRow?.userId ?? null,
      agents: agents.map((ra) => ({
        id: ra.id,
        agentId: ra.agentId,
        turnOrder: ra.turnOrder,
        turnsCompleted: ra.turnsCompleted,
        agentName:
          (ra as any).agent?.agentName ||
          (ra as any).agent?.definition ||
          ra.agentId,
      })),
      users: users.map((ru) => ({
        id: ru.id,
        userId: ru.userId,
        turnOrder: ru.turnOrder,
        turnsCompleted: ru.turnsCompleted,
        displayName:
          (ru as any).user?.displayName?.trim() || `User #${ru.userId}`,
      })),
      messages: messages.map((m) => {
        const agent = (m as any).agent;
        const user = (m as any).user;
        const isUser = m.userId != null;
        return {
          id: m.id,
          agentId: m.agentId,
          userId: m.userId,
          senderType: isUser ? "user" : "agent",
          agentName: isUser
            ? user?.displayName || "User"
            : agent?.agentName || agent?.definition || m.agentId,
          displayName: user?.displayName ?? null,
          roundNumber: m.roundNumber,
          content: m.content,
          createdAt: m.createdAt,
        };
      }),
    };
  }

  async create(
    userId: UserId,
    organizationId: string,
    topic: string,
    agentIds: string[],
    maxTurnsPerAgent: number = 5,
    participantUserIds: UserId[] = [],
  ) {
    if (!topic?.trim()) {
      throw Object.assign(new Error("topic is required"), { status: 400 });
    }
    if (!agentIds || agentIds.length < 2) {
      throw Object.assign(new Error("At least 2 agents are required"), { status: 400 });
    }

    // Scope the lookup by org so a caller can't pull in agents belonging to
    // a different tenant just by sending their UUIDs in the body.
    const agents = await Agent.findAll({
      where: { id: agentIds, organizationId },
      attributes: ["id", "type", "definition", "agentName"],
    });
    if (agents.length !== agentIds.length) {
      const found = new Set(agents.map((a) => a.id));
      const missing = agentIds.filter((id) => !found.has(id));
      throw Object.assign(
        new Error(`Agent(s) not found: ${missing.join(", ")}`),
        { status: 400 },
      );
    }
    const disallowed = agents.filter((a) => (a as any).type === "system");
    if (disallowed.length > 0) {
      const names = disallowed.map((a) => a.definition || a.id).join(", ");
      throw Object.assign(
        new Error(`System agents cannot participate in roundtables: ${names}`),
        { status: 400 },
      );
    }

    // Deduplicate user ids, keep stable order, validate they exist.
    const uniqueUserIds: UserId[] = [];
    for (const id of participantUserIds) {
      if (typeof id !== "number" || !Number.isFinite(id)) continue;
      if (!uniqueUserIds.includes(id)) uniqueUserIds.push(id);
    }
    let participantRows: User[] = [];
    if (uniqueUserIds.length > 0) {
      participantRows = await User.findAll({
        where: { id: uniqueUserIds },
        attributes: ["id", "displayName", "authProvider"],
      });
      if (participantRows.length !== uniqueUserIds.length) {
        const found = new Set(participantRows.map((u) => u.id));
        const missing = uniqueUserIds.filter((id) => !found.has(id));
        throw Object.assign(
          new Error(`User(s) not found: ${missing.join(", ")}`),
          { status: 400 },
        );
      }
      // Client-app JIT users are never valid roundtable participants —
      // their only entry point is the applicationGraph. Reject early so an
      // admin can't accidentally add them via the picker.
      const clientAppParticipants = participantRows.filter(
        (u) => u.authProvider === "client_app",
      );
      if (clientAppParticipants.length > 0) {
        throw Object.assign(
          new Error(
            `User(s) provisioned by an external application cannot join roundtables: ${clientAppParticipants
              .map((u) => u.id)
              .join(", ")}`,
          ),
          { status: 400 },
        );
      }
    }

    const threadId = crypto.randomUUID();
    const hasUsers = uniqueUserIds.length > 0;

    const roundtable = await Roundtable.create({
      topic: topic.trim(),
      maxTurnsPerAgent,
      threadId,
      createdBy: userId,
      includeUser: hasUsers,
    });

    for (let i = 0; i < agentIds.length; i++) {
      await RoundtableAgent.create({
        roundtableId: roundtable.id,
        agentId: agentIds[i],
        turnOrder: i,
      });
    }

    for (let i = 0; i < uniqueUserIds.length; i++) {
      await RoundtableUser.create({
        roundtableId: roundtable.id,
        userId: uniqueUserIds[i],
        turnOrder: i,
      });
    }

    // Notify participants other than the creator
    const creator = await User.findByPk(userId, { attributes: ["displayName"] });
    const creatorName = creator?.displayName?.trim() || `User #${userId}`;
    for (const pid of uniqueUserIds) {
      if (pid === userId) continue;
      try {
        await this.notifications.create({
          userId: pid,
          type: "roundtable_invite",
          title: `${creatorName} invited you to a roundtable`,
          body: topic.trim().slice(0, 200),
          link: `/roundtable/${roundtable.id}`,
          data: { roundtableId: roundtable.id, createdBy: userId },
        });
      } catch (err) {
        logger.warn("Failed to create roundtable invite notification", {
          recipientId: pid,
          error: String(err),
        });
      }
    }

    const firstAgentId = agentIds[0];
    try {
      const res = await fetch(`${AGENT_SERVICE_URL}/api/roundtable/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roundtableId: roundtable.id,
          agentId: firstAgentId,
          userId,
          includeUser: hasUsers,
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

  /**
   * Resumes a roundtable that previously transitioned to `failed`. Forwards
   * to agent_service which trims any orphan trailing messages from the
   * LangGraph checkpoint and re-enqueues the turn that died. Only the
   * roundtable's creator can resume it.
   */
  async resume(roundtableId: string, userId: UserId) {
    const roundtable = await Roundtable.findByPk(roundtableId);
    if (!roundtable) {
      throw Object.assign(new Error("Roundtable not found"), { status: 404 });
    }
    if (roundtable.createdBy !== userId) {
      throw Object.assign(new Error("Not authorized"), { status: 403 });
    }
    if (roundtable.status !== "failed") {
      throw Object.assign(
        new Error(
          `Cannot resume roundtable with status "${roundtable.status}"`,
        ),
        { status: 400 },
      );
    }

    try {
      const res = await fetch(`${AGENT_SERVICE_URL}/api/roundtable/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roundtableId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string })?.error ?? "Failed to resume roundtable",
        );
      }
      return (await res.json()) as {
        ok: boolean;
        agentId?: string;
        round?: number;
        trimmedMessages?: number;
      };
    } catch (err: any) {
      logger.error("Failed to resume roundtable", {
        roundtableId,
        error: err?.message,
      });
      throw Object.assign(
        new Error(err?.message ?? "Failed to resume roundtable"),
        { status: 502 },
      );
    }
  }

  async stop(roundtableId: string, userId: UserId) {
    const roundtable = await Roundtable.findByPk(roundtableId);
    if (!roundtable) {
      throw Object.assign(new Error("Roundtable not found"), { status: 404 });
    }
    if (roundtable.createdBy !== userId) {
      throw Object.assign(new Error("Not authorized"), { status: 403 });
    }
    if (
      roundtable.status !== "running" &&
      roundtable.status !== "pending" &&
      roundtable.status !== "waiting_for_user"
    ) {
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
      // Best effort
    }

    await Roundtable.update(
      { status: "completed", userTurnStartedAt: null },
      { where: { id: roundtableId } },
    );

    return { ok: true };
  }

  /**
   * Forwards a participating user's contribution for the current round to
   * agent_service, which persists the message and resumes the next user or round.
   * The submitter must be the active user whose turn it currently is.
   */
  async submitUserTurn(
    roundtableId: string,
    userId: UserId,
    content: string,
  ) {
    const roundtable = await Roundtable.findByPk(roundtableId);
    if (!roundtable) {
      throw Object.assign(new Error("Roundtable not found"), { status: 404 });
    }
    if (roundtable.status !== "waiting_for_user") {
      throw Object.assign(
        new Error(
          `Cannot submit user turn when status is "${roundtable.status}"`,
        ),
        { status: 400 },
      );
    }

    // Verify the submitter is the active user (i.e. the next roundtable_user
    // whose turns_completed < currentRound+1 in turn_order).
    const participants = await RoundtableUser.findAll({
      where: { roundtableId },
      order: [["turnOrder", "ASC"]],
    });
    if (participants.length === 0) {
      throw Object.assign(
        new Error("This roundtable has no user participants"),
        { status: 400 },
      );
    }
    const roundIndex = roundtable.currentRound;
    const active = participants.find((p) => p.turnsCompleted <= roundIndex) ??
      participants.find((p) => p.turnsCompleted === roundIndex);
    if (!active) {
      throw Object.assign(
        new Error("No active user turn awaiting a submission"),
        { status: 400 },
      );
    }
    if (active.userId !== userId) {
      throw Object.assign(
        new Error("It is not your turn yet"),
        { status: 403 },
      );
    }

    const text = typeof content === "string" ? content : "";
    try {
      const res = await fetch(
        `${AGENT_SERVICE_URL}/api/roundtable/user-turn`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            roundtableId,
            userId,
            content: text,
          }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as any)?.error ?? "Failed to submit user turn",
        );
      }
      return (await res.json()) as { ok: boolean };
    } catch (err: any) {
      logger.error("Failed to submit user turn", {
        roundtableId,
        error: err?.message,
      });
      throw Object.assign(
        new Error(err?.message ?? "Failed to submit user turn"),
        { status: 500 },
      );
    }
  }
}
