import { logger } from "../../logger";
import { numberValue, stringValue } from "../snapshotClient";
import type {
  FeatureScreenCriterion,
  FeatureScreenRowView,
  FeatureScreenView,
} from "../types";
import {
  buildResearchObjectCacheKey,
  buildResearchObjectsForAnchors,
} from "../researchObjectBuilder";
import { assessCapabilityFreshness } from "./freshnessGuard";
import { hashCapabilityParams } from "./discriminatorHash";
import { runPgCapabilityQuery } from "./queryClient";
import type {
  CapabilityFreshness,
  FeatureScreenRow,
  PgCapabilityRunInput,
  PgCapabilityRunResult,
} from "./types";

const VIEW_SCHEMA_VERSION = 2;
const DEFAULT_MAX_ROWS = 10;
const MAX_ROWS_CAP = 20;
const DEFAULT_CANDIDATE_POOL_SIZE = 200;
const MAX_CANDIDATE_POOL_SIZE = 500;

export type FeatureScreenOptions = {
  queryRunner?: (
    replacements: Record<string, unknown>,
  ) => Promise<FeatureScreenRow[]>;
  maxRows?: number;
  candidatePoolSize?: number;
  now?: Date;
};

/**
 * Discriminator for `feature_screen`. The free-form criteria array
 * doesn't fit a single string column — hash the canonicalised criteria
 * string into `criteria_hash`.
 */
export function featureScreenDiscriminators(
  input: PgCapabilityRunInput,
): { criteriaHash: string } {
  return {
    criteriaHash: hashCapabilityParams({
      criteria: stringifyCriteria(criteriaFromInput(input)),
    }),
  };
}

export async function buildFeatureScreenView(
  input: PgCapabilityRunInput,
  options: FeatureScreenOptions = {},
): Promise<PgCapabilityRunResult> {
  const criteria = criteriaFromInput(input);
  if (!criteria.length) {
    return {
      views: {
        featureScreenView: unavailableView([], [
          "No supported public screen criteria were extracted from the request.",
        ]),
      },
      warnings: [],
    };
  }

  const maxRows = clamp(options.maxRows ?? DEFAULT_MAX_ROWS, 1, MAX_ROWS_CAP);
  const candidatePoolSize = clamp(
    options.candidatePoolSize ?? DEFAULT_CANDIDATE_POOL_SIZE,
    maxRows,
    MAX_CANDIDATE_POOL_SIZE,
  );

  if (!options.queryRunner && !isExternalPgConfigured()) {
    return {
      views: {
        featureScreenView: unavailableView(criteria, [
          "External PG warehouse is not configured for feature screening.",
        ]),
      },
      warnings: [],
    };
  }

  try {
    const rows = await (options.queryRunner ?? defaultQueryRunner)({
      MAX_ROWS: maxRows,
      CANDIDATE_POOL_SIZE: candidatePoolSize,
      ...criteriaToParams(criteria),
    });
    const draft = rowsToView(rows, criteria, options.now);
    if (draft.state === "unavailable") {
      return { views: { featureScreenView: draft }, warnings: [] };
    }
    const fanout = await fanOutStockResearchObjects(input, draft);
    return {
      views: { featureScreenView: fanout.view },
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
    const message = "Feature screen query failed.";
    logger.warn("Ask Grahamy PG capability failed", {
      capability: "feature_screen",
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      views: {
        featureScreenView: unavailableView(criteria, [message]),
      },
      warnings: [message],
    };
  }
}

function defaultQueryRunner(
  replacements: Record<string, unknown>,
): Promise<FeatureScreenRow[]> {
  return runPgCapabilityQuery<FeatureScreenRow>(
    "query_feature_screen",
    replacements,
  );
}

function rowsToView(
  rows: FeatureScreenRow[],
  criteria: FeatureScreenCriterion[],
  now?: Date,
): FeatureScreenView {
  if (!rows.length) {
    return unavailableView(criteria, [
      "No feature-screen metadata was available from the PG warehouse.",
    ]);
  }

  const first = rows[0];
  const asOfDate = dateStringValue(first.as_of_date);
  const currentRowCount = integerValue(first.current_row_count);
  const matchedRowCount = integerValue(first.matched_row_count);
  const freshnessAssessment = buildFreshness(first, asOfDate, now);
  const freshness = freshnessAssessment.publicFreshness;
  if (freshnessAssessment.decision === "unavailable") {
    return unavailableView(
      criteria,
      [freshness.warning ?? "Feature screen data is stale."],
      freshness,
      asOfDate,
    );
  }

  if (currentRowCount === 0) {
    return unavailableView(
      criteria,
      ["No current PG feature rows were available for feature screening."],
      freshness,
      asOfDate,
    );
  }

  const publicRows = rows
    .map((row) => rowToPublicRow(row, criteria, asOfDate))
    .filter((row): row is FeatureScreenRowView => !!row);

  const warnings: string[] = [
    "These are screen results to review, not buy/sell recommendations.",
    "Screening criteria use public feature buckets only.",
  ];
  const forwardOverlayAvailable = rows.some((row) =>
    boolValue(row.forward_overlay_available),
  );
  if (!forwardOverlayAvailable && publicRows.length) {
    warnings.push(
      "Historical forward-return overlay is unavailable; rows are ranked from current PG features only.",
    );
  }
  if (matchedRowCount === 0 || !publicRows.length) {
    warnings.push("No stocks matched the supplied public screen criteria.");
  }
  if (freshness.state === "stale") {
    warnings.push(
      freshness.warning ??
        "This feature screen uses stale data and should be treated as a snapshot.",
    );
  } else if (freshness.state === "unknown" && freshness.warning) {
    warnings.push(freshness.warning);
  }

  const researchObjectKeys = Array.from(
    new Set(publicRows.map((row) => row.researchObjectKey).filter(Boolean)),
  );

  return {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state: publicRows.length && !forwardOverlayAvailable ? "partial" : "complete",
    source: "pg_current_features",
    asOfDate,
    screenCriteria: criteria,
    rows: publicRows,
    researchObjectKeys,
    freshness,
    warnings,
  };
}

async function fanOutStockResearchObjects(
  input: PgCapabilityRunInput,
  draft: FeatureScreenView,
): Promise<{
  view: FeatureScreenView;
  researchObjects: import("../types").CachedResearchObject[];
  researchObjectsUpdated: import("../types").CachedResearchObject[];
  stats: { hits: number; misses: number; writes: number } | undefined;
  warnings: string[];
}> {
  const symbols = draft.rows.map((row) => row.symbol);
  const builder = input.researchObjectBuilder ?? buildResearchObjectsForAnchors;
  const result = await builder({
    symbols,
    snapshots: input.snapshots,
    toolOutputs: input.toolOutputs,
    priorResearchObjects: input.priorResearchObjects,
    ...(input.asOfDate ? { asOfDate: input.asOfDate } : {}),
  });
  const keyBySymbol = new Map<string, string>();
  for (const obj of result.objects) {
    if (obj.objectType === "stock") {
      keyBySymbol.set(obj.anchor.toUpperCase(), obj.cacheKey);
    }
  }
  const rowsWithKeys = draft.rows.map((row) => ({
    ...row,
    researchObjectKey:
      keyBySymbol.get(row.symbol.toUpperCase()) ?? row.researchObjectKey,
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

function rowToPublicRow(
  row: FeatureScreenRow,
  criteria: FeatureScreenCriterion[],
  asOfDate: string | undefined,
): FeatureScreenRowView | null {
  const symbol = stringValue(row.symbol)?.toUpperCase();
  const rank = integerValue(row.rank);
  if (!symbol || rank == null) return null;

  const publicRow = compactObject({
    symbol,
    companyName: stringValue(row.company_name),
    sector: stringValue(row.sector),
    rank,
    valuationBucket: stringValue(row.valuation_bucket),
    qualityBucket: stringValue(row.quality_bucket),
    momentumBucket: stringValue(row.momentum_bucket),
    growthBucket: stringValue(row.growth_bucket),
    leverageBucket: stringValue(row.leverage_bucket),
    convictionBucket: stringValue(row.conviction_bucket),
    hitRatePct: roundNumber(row.hit_rate_pct, 1),
    medianReturnPct: roundNumber(row.median_return_pct, 2),
  });

  return {
    ...publicRow,
    reasonBullets: buildReasonBullets(publicRow, criteria, stringValue(row.risk_bucket)),
    researchObjectKey: buildResearchObjectCacheKey(
      "STOCK",
      symbol,
      asOfDate ?? new Date().toISOString().slice(0, 10),
    ),
  };
}

function buildReasonBullets(
  row: Omit<FeatureScreenRowView, "reasonBullets" | "researchObjectKey">,
  criteria: FeatureScreenCriterion[],
  riskBucket?: string,
): string[] {
  const bullets: string[] = [];
  for (const criterion of criteria) {
    if (criterion.factor === "sector") {
      bullets.push(`Sector filter matched ${criterion.bucket}.`);
    } else if (criterion.factor === "risk" && riskBucket) {
      bullets.push(`Risk bucket matched ${criterion.bucket}.`);
    } else {
      bullets.push(`${labelForFactor(criterion.factor)} bucket matched ${criterion.bucket}.`);
    }
  }
  if (row.convictionBucket) {
    bullets.push(`Sector-relative conviction bucket is ${row.convictionBucket}.`);
  }
  if (row.hitRatePct != null || row.medianReturnPct != null) {
    bullets.push("Bounded self-history forward evidence is available.");
  } else {
    bullets.push("Historical forward-return overlay is not available for this row.");
  }
  return bullets.slice(0, 6);
}

function labelForFactor(factor: FeatureScreenCriterion["factor"]): string {
  switch (factor) {
    case "valuation":
      return "Valuation";
    case "quality":
      return "Quality";
    case "momentum":
      return "Momentum";
    case "growth":
      return "Growth";
    case "leverage":
      return "Balance-sheet/leverage";
    case "risk":
      return "Risk";
    case "sector":
      return "Sector";
  }
}

function buildFreshness(
  row: FeatureScreenRow,
  asOfDate: string | undefined,
  now?: Date,
): ReturnType<typeof assessCapabilityFreshness> {
  return assessCapabilityFreshness({
    capability: "feature_screen",
    dataThrough: asOfDate,
    now,
    sources: [
      {
        sourceId: "features_daily",
        tableOrView: "md_features_daily",
        required: true,
        dataThrough: asOfDate,
        lastSuccessAt: dateTimeStringValue(row.features_completed_at),
        refreshState: stringValue(row.features_freshness_state),
      },
      {
        sourceId: "sector_peer_daily",
        tableOrView: "md_research_sector_peer_daily",
        required: false,
        dataThrough: asOfDate,
        lastSuccessAt: dateTimeStringValue(row.peer_completed_at),
        refreshState: stringValue(row.peer_freshness_state),
      },
    ],
  });
}

function unavailableView(
  criteria: FeatureScreenCriterion[],
  warnings: string[],
  freshness: CapabilityFreshness = { state: "unknown" },
  asOfDate?: string,
): FeatureScreenView {
  return {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state: "unavailable",
    source: "pg_current_features",
    asOfDate,
    screenCriteria: criteria,
    rows: [],
    researchObjectKeys: [],
    freshness,
    warnings,
  };
}

function criteriaFromInput(input: PgCapabilityRunInput): FeatureScreenCriterion[] {
  const criteria = input.classification.featureCriteria ?? [];
  return criteria
    .filter((item) => item.factor && typeof item.bucket === "string" && item.bucket.length > 0)
    .slice(0, 7);
}

function criteriaToParams(
  criteria: FeatureScreenCriterion[],
): Record<string, string | null> {
  const params: Record<string, string | null> = {
    VALUATION_BUCKET: null,
    QUALITY_BUCKET: null,
    MOMENTUM_BUCKET: null,
    GROWTH_BUCKET: null,
    LEVERAGE_BUCKET: null,
    RISK_BUCKET: null,
    SECTOR_FILTER: null,
  };
  for (const criterion of criteria) {
    switch (criterion.factor) {
      case "valuation":
        params.VALUATION_BUCKET = criterion.bucket;
        break;
      case "quality":
        params.QUALITY_BUCKET = criterion.bucket;
        break;
      case "momentum":
        params.MOMENTUM_BUCKET = criterion.bucket;
        break;
      case "growth":
        params.GROWTH_BUCKET = criterion.bucket;
        break;
      case "leverage":
        params.LEVERAGE_BUCKET = criterion.bucket;
        break;
      case "risk":
        params.RISK_BUCKET = criterion.bucket;
        break;
      case "sector":
        params.SECTOR_FILTER = criterion.bucket;
        break;
    }
  }
  return params;
}

function stringifyCriteria(criteria: FeatureScreenCriterion[]): string {
  return criteria
    .map((item) => `${item.factor}:${item.bucket}`)
    .sort()
    .join(",");
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
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
