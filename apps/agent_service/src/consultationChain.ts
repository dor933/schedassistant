/**
 * Tracks consultation context in Redis so that when Agent B delegates to a
 * deep agent while being consulted by Agent A, the deep agent result can
 * propagate back to Agent A.
 *
 * Flow:
 * 1. ConsultAgentTool sets context: "Agent B is being consulted by Agent A (in group/chat X)"
 * 2. DelegateToDeepAgentTool reads context: "is Agent B currently in a consultation?"
 *    If yes → stores origin info keyed by delegationId
 * 3. Deep agent worker, after delivering result to Agent B, checks for origin →
 *    if found, also enqueues a callback to Agent A
 * 4. ConsultAgentTool clears context when the consultation ends
 *
 * Redis keys:
 * - `consultation:active:{agentId}` → JSON with origin agent info (TTL: 10 min)
 * - `consultation:delegation:{delegationId}` → JSON with origin agent info (TTL: 30 min)
 */

import Redis from "ioredis";
import { getRedisConfig } from "./redisClient";
import { logger } from "./logger";

/** Consultation context: who asked Agent B and where to send the result back. */
export interface ConsultationOrigin {
  originAgentId: string;
  originGroupId: string | null;
  originSingleChatId: string | null;
  originUserId: number;
}

const ACTIVE_TTL_SECONDS = 10 * 60; // 10 min — covers consultation timeout + buffer
const DELEGATION_TTL_SECONDS = 30 * 60; // 30 min — covers deep agent timeout + buffer

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (!_redis) {
    const config = getRedisConfig();
    _redis = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    _redis.connect().catch((err) => {
      logger.error("consultationChain: Redis connect error", { error: String(err) });
    });
  }
  return _redis;
}

// ── Called by ConsultAgentTool ──

/**
 * Mark that `consultedAgentId` is currently being consulted by `origin`.
 * Called at the start of a consultation.
 */
export async function setActiveConsultation(
  consultedAgentId: string,
  origin: ConsultationOrigin,
): Promise<void> {
  try {
    const key = `consultation:active:${consultedAgentId}`;
    await getRedis().set(key, JSON.stringify(origin), "EX", ACTIVE_TTL_SECONDS);
  } catch (err) {
    logger.error("consultationChain: setActiveConsultation failed", { error: String(err) });
  }
}

/**
 * Clear the active consultation marker.
 * Called when the consultation completes (success or failure).
 */
export async function clearActiveConsultation(consultedAgentId: string): Promise<void> {
  try {
    await getRedis().del(`consultation:active:${consultedAgentId}`);
  } catch (err) {
    logger.error("consultationChain: clearActiveConsultation failed", { error: String(err) });
  }
}

// ── Called by DelegateToDeepAgentTool ──

/**
 * If the current agent is being consulted, store the origin info keyed by
 * delegationId so the deep agent worker can find it later.
 * Returns true if an origin was stored.
 */
export async function linkDelegationToConsultation(
  callerAgentId: string,
  delegationId: string,
): Promise<boolean> {
  try {
    const raw = await getRedis().get(`consultation:active:${callerAgentId}`);
    if (!raw) return false;

    const origin: ConsultationOrigin = JSON.parse(raw);
    await getRedis().set(
      `consultation:delegation:${delegationId}`,
      JSON.stringify(origin),
      "EX",
      DELEGATION_TTL_SECONDS,
    );
    logger.info("consultationChain: linked delegation to consultation", {
      delegationId,
      callerAgentId,
      originAgentId: origin.originAgentId,
    });
    return true;
  } catch (err) {
    logger.error("consultationChain: linkDelegationToConsultation failed", { error: String(err) });
    return false;
  }
}

// ── Called by deep agent worker ──

/**
 * Check if a delegation has a consultation origin. If so, return it and
 * delete the key (one-time use).
 */
export async function popConsultationOrigin(
  delegationId: string,
): Promise<ConsultationOrigin | null> {
  try {
    const key = `consultation:delegation:${delegationId}`;
    const raw = await getRedis().get(key);
    if (!raw) return null;
    await getRedis().del(key);
    return JSON.parse(raw) as ConsultationOrigin;
  } catch (err) {
    logger.error("consultationChain: popConsultationOrigin failed", { error: String(err) });
    return null;
  }
}
