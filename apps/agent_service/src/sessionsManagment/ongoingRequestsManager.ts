import { randomUUID } from "node:crypto";
import { Agent } from "@scheduling-agent/database";
import type { OngoingRequest, UserId } from "@scheduling-agent/types";
import { logger } from "../logger";

function normalizeList(raw: unknown): OngoingRequest[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is OngoingRequest =>
      r != null &&
      typeof r === "object" &&
      typeof (r as OngoingRequest).id === "string" &&
      typeof (r as OngoingRequest).userId === "number" &&
      typeof (r as OngoingRequest).request === "string" &&
      typeof (r as OngoingRequest).createdAt === "string",
  );
}

/**
 * Appends one entry to `agents.ongoing_requests` (JSONB) for this agent.
 */
export async function addOngoingRequest(
  agentId: string,
  userId: UserId,
  request: string,
): Promise<OngoingRequest | null> {
  const trimmed = request.trim();
  if (!trimmed) return null;

  try {
    const agent = await Agent.findByPk(agentId, { attributes: ["id", "ongoingRequests"] });
    if (!agent) {
      logger.error("addOngoingRequest: agent not found", { agentId });
      return null;
    }
    const list = normalizeList(agent.ongoingRequests);
    const entry: OngoingRequest = {
      id: randomUUID(),
      userId,
      request: trimmed,
      createdAt: new Date().toISOString(),
    };
    list.push(entry);
    await agent.update({ ongoingRequests: list });
    return entry;
  } catch (err) {
    logger.error("addOngoingRequest failed", {
      agentId,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Removes one ongoing request by `id` from `agents.ongoing_requests`.
 */
export async function removeOngoingRequest(
  agentId: string,
  requestId: string,
): Promise<boolean> {
  try {
    const agent = await Agent.findByPk(agentId, { attributes: ["id", "ongoingRequests"] });
    if (!agent) {
      logger.error("removeOngoingRequest: agent not found", { agentId });
      return false;
    }
    const list = normalizeList(agent.ongoingRequests);
    const next = list.filter((r) => r.id !== requestId);
    if (next.length === list.length) return false;
    await agent.update({ ongoingRequests: next });
    return true;
  } catch (err) {
    logger.error("removeOngoingRequest failed", {
      agentId,
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
