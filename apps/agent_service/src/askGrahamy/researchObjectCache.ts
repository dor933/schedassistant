import Redis from "ioredis";
import { getRedisConfig } from "../redisClient";
import { logger } from "../logger";

const REDIS_KEY_PREFIX = "ask-grahamy:research-object:";
const DEFAULT_TTL_SECONDS = 36 * 60 * 60;

let redisClient: Redis | null = null;

export type ResearchObjectCacheHit<T> = {
  cacheKey: string;
  value: T;
};

export function buildResearchObjectCacheKey(
  objectType: "STOCK" | "SECTOR" | "REGIME",
  anchor: string,
  date: string,
): string {
  return `${objectType}:${anchor.toUpperCase()}:${date}`;
}

export async function getCachedResearchObject<T>(
  cacheKey: string,
): Promise<ResearchObjectCacheHit<T> | null> {
  if (isCacheDisabled()) return null;
  try {
    const raw = await getRedis().get(redisKey(cacheKey));
    if (!raw) return null;
    return { cacheKey, value: JSON.parse(raw) as T };
  } catch (err) {
    logger.warn("Ask Grahamy research cache read failed", {
      cacheKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function setCachedResearchObject<T>(
  cacheKey: string,
  value: T,
): Promise<void> {
  if (isCacheDisabled()) return;
  try {
    await getRedis().set(
      redisKey(cacheKey),
      JSON.stringify(value),
      "EX",
      getCacheTtlSeconds(),
    );
  } catch (err) {
    logger.warn("Ask Grahamy research cache write failed", {
      cacheKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function getRedis(): Redis {
  if (redisClient) return redisClient;
  const config = getRedisConfig();
  redisClient = new Redis({
    host: config.host,
    port: config.port,
    ...(config.password ? { password: config.password } : {}),
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  redisClient.connect().catch((err) => {
    logger.warn("Ask Grahamy research cache Redis connect failed", {
      error: String(err),
    });
  });
  return redisClient;
}

function redisKey(cacheKey: string): string {
  return `${REDIS_KEY_PREFIX}${cacheKey}`;
}

function getCacheTtlSeconds(): number {
  return Number(
    process.env.ASK_GRAHAMY_RESEARCH_OBJECT_TTL_SECONDS ||
      DEFAULT_TTL_SECONDS,
  );
}

function isCacheDisabled(): boolean {
  return process.env.ASK_GRAHAMY_RESEARCH_CACHE_DISABLED === "true";
}
