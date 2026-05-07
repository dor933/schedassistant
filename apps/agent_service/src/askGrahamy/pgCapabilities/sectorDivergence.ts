import { logger } from "../../logger";
import { numberValue, stringValue } from "../snapshotClient";
import type { SectorDivergenceRowView, SectorDivergenceView } from "../types";
import {
  buildResearchObjectCacheKey,
  buildResearchObjectsForAnchors,
} from "../researchObjectBuilder";
import { assessCapabilityFreshness } from "./freshnessGuard";
import { runPgCapabilityQuery } from "./queryClient";
import type {
  CapabilityFreshness,
  PgCapabilityRunInput,
  PgCapabilityRunResult,
  SectorDivergenceRow,
} from "./types";

const VIEW_SCHEMA_VERSION = 2;
const DEFAULT_MAX_ROWS = 10;
const MAX_ROWS_CAP = 20;
const CLEAR_DIVERGENCE_TYPE = "conviction_but_weak_price_action";
const NO_CLEAR_DIVERGENCE_WARNING =
  "No clear conviction-versus-momentum divergence was found in the latest view.";

export type SectorDivergenceOptions = {
  queryRunner?: (
    replacements: Record<string, unknown>,
  ) => Promise<SectorDivergenceRow[]>;
  maxRows?: number;
  now?: Date;
};

/**
 * Cache-key params for `sector_momentum_vs_conviction_divergence`. The query
 * has no message-derived inputs (default MAX_ROWS only), so two same-day
 * callers share one cached view.
 */
export function sectorDivergenceCacheKeyParams(
  _input: PgCapabilityRunInput,
): Record<string, string | number | boolean> {
  return {};
}

export async function buildSectorDivergenceView(
  input: PgCapabilityRunInput,
  options: SectorDivergenceOptions = {},
): Promise<PgCapabilityRunResult> {
  const maxRows = clampMaxRows(options.maxRows ?? DEFAULT_MAX_ROWS);

  if (!options.queryRunner && !isExternalPgConfigured()) {
    return {
      views: {
        sectorDivergenceView: unavailableView([
          "External PG warehouse is not configured for sector divergence queries.",
        ]),
      },
      warnings: [],
    };
  }

  try {
    const rows = await (options.queryRunner ?? defaultQueryRunner)({
      MAX_ROWS: maxRows,
    });
    const draft = rowsToView(rows, options.now);
    if (draft.state === "unavailable" || !draft.rows.length) {
      return { views: { sectorDivergenceView: draft }, warnings: [] };
    }
    const fanout = await fanOutSectorResearchObjects(input, draft);
    return {
      views: { sectorDivergenceView: fanout.view },
      warnings: fanout.warnings,
      ...(fanout.researchObjects.length
        ? { researchObjects: fanout.researchObjects }
        : {}),
      ...(fanout.researchObjectsUpdated.length
        ? { researchObjectsUpdated: fanout.researchObjectsUpdated }
        : {}),
      ...(fanout.stats
        ? { researchObjectCacheStats: fanout.stats }
        : {}),
    };
  } catch (err) {
    const message = "Sector momentum/conviction divergence query failed.";
    logger.warn("Ask Grahamy PG capability failed", {
      capability: "sector_momentum_vs_conviction_divergence",
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      views: {
        sectorDivergenceView: unavailableView([message]),
      },
      warnings: [message],
    };
  }
}

async function fanOutSectorResearchObjects(
  input: PgCapabilityRunInput,
  draft: SectorDivergenceView,
): Promise<{
  view: SectorDivergenceView;
  researchObjects: import("../types").CachedResearchObject[];
  researchObjectsUpdated: import("../types").CachedResearchObject[];
  stats: { hits: number; misses: number; writes: number } | undefined;
  warnings: string[];
}> {
  const sectors = draft.rows.map((row) => row.sector);
  const builder = input.researchObjectBuilder ?? buildResearchObjectsForAnchors;
  const result = await builder({
    sectors,
    snapshots: input.snapshots,
    toolOutputs: input.toolOutputs,
    priorResearchObjects: input.priorResearchObjects,
  });
  const keyBySector = new Map<string, string>();
  for (const obj of result.objects) {
    if (obj.objectType === "sector") {
      keyBySector.set(obj.anchor.toUpperCase(), obj.cacheKey);
    }
  }
  const rowsWithKeys = draft.rows.map((row) => ({
    ...row,
    researchObjectKey:
      keyBySector.get(row.sector.toUpperCase()) ?? row.researchObjectKey,
  }));
  const researchObjectKeys = Array.from(
    new Set(rowsWithKeys.map((row) => row.researchObjectKey).filter(Boolean)),
  );
  return {
    view: { ...draft, rows: rowsWithKeys, researchObjectKeys },
    researchObjects: result.objects,
    researchObjectsUpdated: result.objectsUpdated,
    stats: result.stats,
    warnings: result.warnings,
  };
}

function defaultQueryRunner(
  replacements: Record<string, unknown>,
): Promise<SectorDivergenceRow[]> {
  return runPgCapabilityQuery<SectorDivergenceRow>(
    "query_sector_divergence",
    replacements,
  );
}

function rowsToView(
  rows: SectorDivergenceRow[],
  now?: Date,
): SectorDivergenceView {
  if (!rows.length) {
    return unavailableView([
      "No sector divergence rows were available from the PG warehouse.",
    ]);
  }

  const first = rows[0];
  const asOfDate = dateStringValue(first.as_of_date);
  const publicRows = rows
    .map((row) => rowToPublicRow(row, asOfDate))
    .filter((row): row is SectorDivergenceRowView => {
      return !!row && row.divergenceType === CLEAR_DIVERGENCE_TYPE;
    });

  const overlayAvailable = rows.some((row) => boolValue(row.overlay_available));
  const evaluatedSectorCount =
    integerValue(first.evaluated_sector_count) ?? rows.length;
  const clearDivergenceCount =
    integerValue(first.clear_divergence_count) ?? publicRows.length;
  const freshnessAssessment = buildFreshness(first, asOfDate, now);
  const freshness = freshnessAssessment.publicFreshness;
  if (freshnessAssessment.decision === "unavailable") {
    return unavailableView(
      [freshness.warning ?? "Sector divergence data is stale."],
      freshness,
    );
  }

  const warnings: string[] = [];
  if (!overlayAvailable) {
    warnings.push(
      "Historical forward-return overlay is unavailable; divergence ranking uses current conviction and momentum data only.",
    );
  }
  if (freshness.state === "stale") {
    warnings.push(
      freshness.warning ??
        "This sector divergence view uses stale data and should be treated as a snapshot.",
    );
  } else if (freshness.state === "unknown" && freshness.warning) {
    warnings.push(freshness.warning);
  }
  if (!publicRows.length) {
    warnings.unshift(NO_CLEAR_DIVERGENCE_WARNING);
  }
  const researchObjectKeys = Array.from(
    new Set(publicRows.map((row) => row.researchObjectKey).filter(Boolean)),
  );

  return {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state: publicRows.length && !overlayAvailable ? "partial" : "complete",
    source: "pg_sector_peer_daily",
    period: "latest",
    asOfDate,
    evaluatedSectorCount,
    clearDivergenceCount,
    rows: publicRows,
    researchObjectKeys,
    freshness,
    warnings,
  };
}

function rowToPublicRow(
  row: SectorDivergenceRow,
  asOfDate: string | undefined,
): SectorDivergenceRowView | null {
  const sector = stringValue(row.sector);
  const rank = integerValue(row.rank);
  if (!sector || rank == null) return null;

  const publicRow = compactObject({
    sector,
    rank,
    convictionScorePct: roundNumber(row.conviction_score_pct, 1),
    convictionBucket: stringValue(row.conviction_bucket),
    momentumScorePct: roundNumber(row.momentum_score_pct, 1),
    momentumBucket: stringValue(row.momentum_bucket),
    divergenceType: stringValue(row.divergence_type),
    hitRatePct: roundNumber(row.hit_rate_pct, 1),
    medianForwardReturnPct: roundNumber(row.median_forward_return_pct, 2),
    evidenceStrength: stringValue(row.evidence_strength),
  });

  return {
    ...publicRow,
    interpretationBullets: buildInterpretationBullets(publicRow),
    researchObjectKey: buildResearchObjectCacheKey(
      "SECTOR",
      sector,
      asOfDate ?? new Date().toISOString().slice(0, 10),
    ),
  };
}

function buildInterpretationBullets(
  row: Omit<SectorDivergenceRowView, "interpretationBullets" | "researchObjectKey">,
): string[] {
  const bullets: string[] = [];
  if (row.convictionBucket) {
    bullets.push(`Conviction bucket is ${row.convictionBucket}.`);
  } else if (row.convictionScorePct != null) {
    bullets.push("Current sector-relative conviction is available.");
  }
  if (row.momentumBucket) {
    bullets.push(`Price momentum bucket is ${row.momentumBucket}.`);
  }
  if (row.divergenceType === "conviction_but_weak_price_action") {
    bullets.push(
      "Conviction is constructive but current price action is not confirming it.",
    );
  } else if (row.divergenceType === "price_action_confirms_conviction") {
    bullets.push("Price action is confirming the constructive conviction signal.");
  } else if (row.divergenceType === "price_momentum_without_conviction") {
    bullets.push("Price momentum is stronger than the conviction evidence.");
  }
  if (row.hitRatePct != null) {
    bullets.push("Historical forward hit-rate evidence is available.");
  }
  if (row.medianForwardReturnPct != null) {
    bullets.push("Historical median forward-return evidence is available.");
  }
  return bullets.slice(0, 5);
}

function buildFreshness(
  row: SectorDivergenceRow,
  asOfDate: string | undefined,
  now?: Date,
): ReturnType<typeof assessCapabilityFreshness> {
  return assessCapabilityFreshness({
    capability: "sector_momentum_vs_conviction_divergence",
    dataThrough: asOfDate,
    now,
    sources: [
      {
        sourceId: "sector_peer_daily",
        tableOrView: "md_research_sector_peer_daily",
        required: true,
        dataThrough: asOfDate,
        lastSuccessAt: dateTimeStringValue(row.peer_completed_at),
        refreshState: stringValue(row.peer_freshness_state),
      },
      {
        sourceId: "sector_regime_forward_aggregate",
        tableOrView: "md_research_sector_regime_fwd_agg",
        required: false,
        lastSuccessAt: dateTimeStringValue(row.forward_completed_at),
        refreshState: stringValue(row.forward_freshness_state),
      },
    ],
  });
}

function unavailableView(
  warnings: string[],
  freshness: CapabilityFreshness = { state: "unknown" },
): SectorDivergenceView {
  return {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state: "unavailable",
    source: "pg_sector_peer_daily",
    period: "latest",
    evaluatedSectorCount: 0,
    clearDivergenceCount: 0,
    rows: [],
    researchObjectKeys: [],
    freshness,
    warnings,
  };
}

function clampMaxRows(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_ROWS;
  return Math.max(1, Math.min(MAX_ROWS_CAP, Math.floor(value)));
}

function isExternalPgConfigured(): boolean {
  return Boolean(process.env.EXTERNAL_PG_HOST && process.env.EXTERNAL_PG_DATABASE);
}

function integerValue(value: unknown): number | undefined {
  const parsed = numericValue(value);
  if (parsed == null || !Number.isFinite(parsed)) return undefined;
  return Math.trunc(parsed);
}

function roundNumber(value: unknown, decimals: number): number | undefined {
  const parsed = numericValue(value);
  if (parsed == null || !Number.isFinite(parsed)) return undefined;
  const scale = 10 ** decimals;
  return Math.round(parsed * scale) / scale;
}

function numericValue(value: unknown): number | undefined {
  const direct = numberValue(value);
  if (direct != null) return direct;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boolValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return value === 1;
}

function dateStringValue(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return stringValue(value);
}

function dateTimeStringValue(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return stringValue(value);
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined && item !== null) out[key] = item;
  }
  return out as T;
}
