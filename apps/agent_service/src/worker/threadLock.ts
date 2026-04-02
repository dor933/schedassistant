import Redis from "ioredis";
import { randomUUID } from "crypto";
import type { RedisConfig } from "../redisClient";

const LOCK_PREFIX = "agent:chat:thread-lock:";
const LOCK_TTL_SEC = Number(process.env.AGENT_CHAT_LOCK_TTL_SEC ?? "600");
const SPIN_MS = 25;

/**
 * Distributed lock per `threadId` so only one chat job runs at a time for that thread
 * (across worker concurrency and multiple instances).
 */
export function createThreadLockRedis(config: RedisConfig): Redis {
  return new Redis({
    host: config.host,
    port: config.port,
    ...(config.password ? { password: config.password } : {}),
    maxRetriesPerRequest: null,
  });
}

/**
 * Blocks until the lock for `threadId` is acquired, then runs `fn`.
 * Releases the lock in `finally` (best-effort compare-and-delete).
 */
export async function withThreadLock<T>(
  redis: Redis,
  threadId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${LOCK_PREFIX}${threadId}`;
  const token = randomUUID();

  while (true) {
    const ok = await redis.set(key, token, "EX", LOCK_TTL_SEC, "NX");
    if (ok === "OK") {
      break;
    }
    await new Promise((r) => setTimeout(r, SPIN_MS));
  }

  try {
    return await fn();
  } finally {
    await releaseLock(redis, key, token);
  }
}

/**
 * Tries to acquire the lock for up to `timeoutMs` milliseconds.
 * If acquired, runs `fn` and releases. If timeout is reached, throws `LockTimeoutError`.
 */
export class LockTimeoutError extends Error {
  constructor(lockKey: string, timeoutMs: number) {
    super(`Could not acquire lock "${lockKey}" within ${timeoutMs}ms — the target agent is busy.`);
    this.name = "LockTimeoutError";
  }
}

export async function withThreadLockTimeout<T>(
  redis: Redis,
  threadId: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${LOCK_PREFIX}${threadId}`;
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const ok = await redis.set(key, token, "EX", LOCK_TTL_SEC, "NX");
    if (ok === "OK") {
      break;
    }
    if (Date.now() >= deadline) {
      throw new LockTimeoutError(key, timeoutMs);
    }
    await new Promise((r) => setTimeout(r, SPIN_MS));
  }

  try {
    return await fn();
  } finally {
    await releaseLock(redis, key, token);
  }
}

async function releaseLock(redis: Redis, key: string, token: string): Promise<void> {
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  try {
    await redis.eval(script, 1, key, token);
  } catch {
    // Lock may have expired; ignore.
  }
}
