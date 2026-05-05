import type { PublicFreshnessView } from "../types";
import {
  containsPipelineOverlayForbiddenTerm,
  isPipelineOverlayForbiddenKey,
} from "./forbiddenFields";
import type {
  PipelineOverlayState,
  PublicOverlayMapResult,
} from "./types";

export type PublicOverlayBase = {
  viewSchemaVersion: number;
  state: PipelineOverlayState;
  freshness?: PublicFreshnessView;
  warnings: string[];
};

export function createUnavailableOverlayResult<TView>(
  warning: string,
  freshness?: PublicFreshnessView,
): PublicOverlayMapResult<TView> {
  return {
    state: "unavailable",
    freshness,
    warnings: [warning],
  };
}

export function createPublicOverlayResult<TView extends PublicOverlayBase>(
  view: TView,
): PublicOverlayMapResult<TView> {
  return {
    state: view.state,
    view: stripForbiddenPipelineOverlayFields(view) as TView,
    freshness: view.freshness,
    warnings: view.warnings,
  };
}

export function stripForbiddenPipelineOverlayFields(value: unknown): unknown {
  return stripForbidden(value, new WeakSet<object>());
}

export function assertNoForbiddenPipelineOverlayFields(value: unknown): void {
  const sanitized = stripForbiddenPipelineOverlayFields(value);
  const original = JSON.stringify(value);
  const cleaned = JSON.stringify(sanitized);
  if (original !== cleaned) {
    throw new Error("Pipeline overlay payload contains forbidden public fields.");
  }
}

function stripForbidden(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return containsPipelineOverlayForbiddenTerm(value) ? undefined : value;
  }
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .map((item) => stripForbidden(item, seen))
      .filter((item) => item !== undefined);
    return items;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isPipelineOverlayForbiddenKey(key)) continue;
    if (normalizeKey(key) === "anchor") {
      const safeAnchor = stripPublicAnchor(item, seen);
      if (safeAnchor !== undefined) out[key] = safeAnchor;
      continue;
    }
    const next = stripForbidden(item, seen);
    if (next !== undefined) out[key] = next;
  }
  if (Object.keys(out).length === 0) return undefined;
  return out;
}

function stripPublicAnchor(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  if (seen.has(value)) return undefined;
  seen.add(value);
  const allowed = new Set(["type", "symbol", "sector", "regime", "label"]);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    const next = stripForbidden(item, seen);
    if (next !== undefined) out[key] = next;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}
