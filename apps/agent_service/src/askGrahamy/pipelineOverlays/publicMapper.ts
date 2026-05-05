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
    const next = stripForbidden(item, seen);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

