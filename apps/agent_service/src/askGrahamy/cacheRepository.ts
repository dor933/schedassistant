import { logger } from "../logger";
import { queryExternalReadonly } from "../utils/externalReadonlyDb";
import type { CachedCapabilityView } from "./pgCapabilities/types";
import type { CachedResearchObject } from "./types";

function normalizeIds(ids: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids ?? []) {
    const value = String(id ?? "").trim();
    if (!/^\d+$/.test(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export async function loadCachedResearchObjectsByIds(
  ids: readonly string[] | undefined,
): Promise<CachedResearchObject[]> {
  const normalized = normalizeIds(ids);
  if (!normalized.length) return [];

  try {
    const rows = await queryExternalReadonly<{ id: unknown; payload: unknown }>(
      `SELECT id, payload
         FROM research_objects
        WHERE id IN (${normalized.join(",")})
          AND (expires_at IS NULL OR expires_at > NOW())`,
    );
    return rows
      .map((row) => row.payload)
      .filter(isRecord)
      .map((payload) => payload as unknown as CachedResearchObject);
  } catch (err) {
    logger.warn("Ask Grahamy cache repository: failed to load research object ids", {
      ids: normalized,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function loadCachedCapabilityViewsByIds(
  ids: readonly string[] | undefined,
): Promise<CachedCapabilityView[]> {
  const normalized = normalizeIds(ids);
  if (!normalized.length) return [];

  try {
    const rows = await queryExternalReadonly<{ id: unknown; payload: unknown }>(
      `SELECT id, payload
         FROM cached_capability_views
        WHERE id IN (${normalized.join(",")})
          AND (expires_at IS NULL OR expires_at > NOW())`,
    );
    return rows
      .map((row) => row.payload)
      .filter(isRecord)
      .map((payload) => payload as unknown as CachedCapabilityView);
  } catch (err) {
    logger.warn("Ask Grahamy cache repository: failed to load capability view ids", {
      ids: normalized,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
