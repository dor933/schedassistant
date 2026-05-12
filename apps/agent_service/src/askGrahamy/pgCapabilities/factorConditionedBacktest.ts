import { logger } from "../../logger";
import { numberValue, stringValue } from "../snapshotClient";
import type {
  FactorBacktestClassification,
  FactorBacktestCriterion,
  FactorBacktestHorizon,
  FactorBacktestView,
} from "../types";
import {
  buildResearchObjectCacheKey,
  buildResearchObjectsForAnchors,
} from "../researchObjectBuilder";
import { hashCapabilityParams } from "./discriminatorHash";
import { assessCapabilityFreshness } from "./freshnessGuard";
import { runPgCapabilityQuery } from "./queryClient";
import type {
  CapabilityFreshness,
  FactorBacktestRow,
  PgCapabilityRunInput,
  PgCapabilityRunResult,
} from "./types";

const VIEW_SCHEMA_VERSION = 2;
const DEFAULT_HORIZON: FactorBacktestHorizon = "60-day";
const MAX_SAMPLE_SIZE = 250000;
const THIN_SAMPLE_THRESHOLD = 30;
const ROBUST_SAMPLE_THRESHOLD = 100;

export type FactorConditionedBacktestOptions = {
  queryRunner?: (
    replacements: Record<string, unknown>,
  ) => Promise<FactorBacktestRow[]>;
  maxSampleSize?: number;
  now?: Date;
};

/**
 * Discriminator for `factor_conditioned_backtest`. Multi-field criteria
 * + horizon don't fit a single string column — hash the canonicalised
 * params into `criteria_hash`.
 */
export function factorConditionedBacktestDiscriminators(
  input: PgCapabilityRunInput,
): { criteriaHash: string } {
  const backtest = backtestFromInput(input);
  return {
    criteriaHash: hashCapabilityParams({
      criteria: stringifyCriteria(backtest.criteria),
      horizon: backtest.horizon ?? DEFAULT_HORIZON,
      unsupportedHorizon: backtest.unsupportedHorizon ?? "",
      unsupportedCriteria: (backtest.unsupportedCriteria ?? []).join(","),
    }),
  };
}

export async function buildFactorConditionedBacktestView(
  input: PgCapabilityRunInput,
  options: FactorConditionedBacktestOptions = {},
): Promise<PgCapabilityRunResult> {
  const backtest = backtestFromInput(input);
  const horizon = backtest.horizon ?? DEFAULT_HORIZON;
  if (backtest.unsupportedCriteria?.length) {
    return {
      views: {
        factorBacktestView: unavailableView(backtest.criteria, horizon, [
          `Unsupported public factor criteria: ${backtest.unsupportedCriteria.join(", ")}.`,
          "Supported factor backtest criteria are valuation, quality, momentum, growth, leverage, and sector.",
        ]),
      },
      warnings: [],
    };
  }

  if (backtest.unsupportedHorizon) {
    return {
      views: {
        factorBacktestView: unavailableView(backtest.criteria, horizon, [
          `Unsupported backtest horizon: ${backtest.unsupportedHorizon}.`,
        ]),
      },
      warnings: [],
    };
  }

  if (!backtest.criteria.length) {
    return {
      views: {
        factorBacktestView: unavailableView([], horizon, [
          "No supported public factor criteria were extracted from the request.",
        ]),
      },
      warnings: [],
    };
  }

  if (!options.queryRunner && !isExternalPgConfigured()) {
    return {
      views: {
        factorBacktestView: unavailableView(backtest.criteria, horizon, [
          "External PG warehouse is not configured for factor backtesting.",
        ]),
      },
      warnings: [],
    };
  }

  try {
    const maxSampleSize = clamp(
      options.maxSampleSize ?? MAX_SAMPLE_SIZE,
      THIN_SAMPLE_THRESHOLD,
      MAX_SAMPLE_SIZE,
    );
    const rows = await (options.queryRunner ?? defaultQueryRunner)({
      HORIZON: horizon,
      MAX_SAMPLE_SIZE: maxSampleSize,
      ...criteriaToParams(backtest.criteria),
    });
    const draft = rowsToView(
      rows,
      backtest.criteria,
      horizon,
      publicNotesForInput(backtest, input.message),
      options.now,
    );
    if (draft.state === "unavailable" || !draft.contributingResearchObjectKeys.length) {
      return {
        views: {
          factorBacktestView: draft,
        },
        warnings: [],
      };
    }
    const fanout = await fanOutContributingResearchObjects(input, draft, rows[0]);
    return {
      views: {
        factorBacktestView: fanout.view,
      },
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
    const message = "Factor-conditioned backtest query failed.";
    logger.warn("Ask Grahamy PG capability failed", {
      capability: "factor_conditioned_backtest",
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      views: {
        factorBacktestView: unavailableView(backtest.criteria, horizon, [message]),
      },
      warnings: [message],
    };
  }
}

function defaultQueryRunner(
  replacements: Record<string, unknown>,
): Promise<FactorBacktestRow[]> {
  return runPgCapabilityQuery<FactorBacktestRow>(
    "query_factor_conditioned_backtest",
    replacements,
  );
}

function rowsToView(
  rows: FactorBacktestRow[],
  criteria: FactorBacktestCriterion[],
  horizon: FactorBacktestHorizon,
  publicNotes: string[],
  now?: Date,
): FactorBacktestView {
  if (!rows.length) {
    return unavailableView(criteria, horizon, [
      "No factor-backtest metadata was available from the PG warehouse.",
    ]);
  }

  const row = rows[0];
  const asOfDate = dateStringValue(row.as_of_date);
  const contributingSymbols = symbolListValue(row.contributing_symbols);
  const freshnessAssessment = buildFreshness(row, asOfDate, now);
  const freshness = freshnessAssessment.publicFreshness;
  if (freshnessAssessment.decision === "unavailable") {
    return unavailableView(
      criteria,
      horizon,
      [freshness.warning ?? "Factor backtest data is stale."],
      freshness,
    );
  }

  const sampleSize = integerValue(row.sample_size) ?? 0;
  const matchedRowCount = integerValue(row.matched_row_count) ?? 0;
  const cappedSample = boolValue(row.capped_sample);
  const sampleAdequacy = adequacyForSample(sampleSize);
  const warnings: string[] = [
    "This is historical/base-rate factor evidence, not a prediction or recommendation.",
  ];
  if (asOfDate) {
    warnings.push(
      `The historical sample is through ${asOfDate} for the selected horizon; this is not today's or latest market-data snapshot.`,
    );
  }
  warnings.push(...publicNotes);
  if (criteria.length === 1) {
    warnings.push(
      "This is a broad one-factor backtest; use it as directional context only.",
    );
  }
  if (matchedRowCount === 0 || sampleSize === 0) {
    warnings.push("No historical observations matched the supplied public factor criteria.");
  }
  if (sampleAdequacy === "THIN") {
    warnings.push("Sample size is thin; do not overstate the result.");
  }
  if (cappedSample) {
    warnings.push(
      "Warehouse observations exceeded the safety cap; aggregate statistics use the bounded recent sample only.",
    );
  }
  if (freshness.state === "stale") {
    warnings.push(
      freshness.warning ??
        "This factor backtest uses stale data and should be treated as a historical snapshot.",
    );
  } else if (freshness.state === "unknown" && freshness.warning) {
    warnings.push(freshness.warning);
  }

  return {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state: sampleAdequacy === "THIN" && sampleSize > 0 ? "partial" : "complete",
    source: "pg_factor_history",
    horizon,
    criteria,
    ...(sampleSize >= 0 ? { sampleSize } : {}),
    ...compactObject({
      hitRatePct: roundNumber(row.hit_rate_pct, 1),
      medianReturnPct: roundNumber(row.median_return_pct, 2),
      p25ReturnPct: roundNumber(row.p25_return_pct, 2),
      p75ReturnPct: roundNumber(row.p75_return_pct, 2),
    }),
    sampleAdequacy,
    contributingResearchObjectKeys: contributingSymbols.map((symbol) =>
      buildResearchObjectCacheKey(
        "STOCK",
        symbol,
        asOfDate ?? new Date().toISOString().slice(0, 10),
      ),
    ),
    freshness,
    warnings,
  };
}

async function fanOutContributingResearchObjects(
  input: PgCapabilityRunInput,
  draft: FactorBacktestView,
  row: FactorBacktestRow | undefined,
): Promise<{
  view: FactorBacktestView;
  researchObjects: import("../types").CachedResearchObject[];
  researchObjectsUpdated: import("../types").CachedResearchObject[];
  stats: { hits: number; misses: number; writes: number } | undefined;
  warnings: string[];
}> {
  const symbols = symbolListValue(row?.contributing_symbols);
  const builder = input.researchObjectBuilder ?? buildResearchObjectsForAnchors;
  const result = await builder({
    symbols,
    snapshots: input.snapshots,
    toolOutputs: input.toolOutputs,
    priorResearchObjects: input.priorResearchObjects,
  });
  const keyBySymbol = new Map<string, string>();
  for (const obj of result.objects) {
    if (obj.objectType === "stock") {
      keyBySymbol.set(obj.anchor.toUpperCase(), obj.cacheKey);
    }
  }
  const contributingResearchObjectKeys = symbols
    .map((symbol, index) => {
      const fallback = draft.contributingResearchObjectKeys[index];
      return keyBySymbol.get(symbol.toUpperCase()) ?? fallback;
    })
    .filter((key): key is string => Boolean(key));
  return {
    view: {
      ...draft,
      contributingResearchObjectKeys: Array.from(
        new Set(contributingResearchObjectKeys),
      ),
    },
    researchObjects: result.objects,
    researchObjectsUpdated: result.objectsUpdated,
    stats: result.stats,
    warnings: result.warnings,
  };
}

function buildFreshness(
  row: FactorBacktestRow,
  asOfDate: string | undefined,
  now?: Date,
): ReturnType<typeof assessCapabilityFreshness> {
  return assessCapabilityFreshness({
    capability: "factor_conditioned_backtest",
    dataThrough: asOfDate,
    now,
    maxTradingDayLag: 260,
    hardTradingDayLag: 520,
    sources: [
      {
        sourceId: "factor_history",
        tableOrView: "sweep_universe",
        required: false,
        dataThrough: asOfDate,
      },
    ],
  });
}

function unavailableView(
  criteria: FactorBacktestCriterion[],
  horizon: FactorBacktestHorizon,
  warnings: string[],
  freshness: CapabilityFreshness = { state: "unknown" },
): FactorBacktestView {
  return {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state: "unavailable",
    source: "pg_factor_history",
    horizon,
    criteria,
    contributingResearchObjectKeys: [],
    freshness,
    warnings,
  };
}

function backtestFromInput(input: PgCapabilityRunInput): FactorBacktestClassification {
  return input.classification.factorBacktest ?? {
    criteria: [],
    horizon: DEFAULT_HORIZON,
  };
}

function publicNotesForInput(
  backtest: FactorBacktestClassification,
  message: string,
): string[] {
  const notes = [...(backtest.notes ?? [])];
  if (
    /\b(?:rsi\s+(?:is\s+)?low|low\s+rsi|oversold)\b/i.test(message) &&
    backtest.criteria.some(
      (criterion) => criterion.factor === "momentum" && criterion.bucket === "WEAK",
    )
  ) {
    notes.push(
      "In V1, low-RSI requests are represented by the public weak momentum bucket; no raw RSI threshold is exposed.",
    );
  }
  return Array.from(new Set(notes)).slice(0, 5);
}

function criteriaToParams(
  criteria: FactorBacktestCriterion[],
): Record<string, string | null> {
  const params: Record<string, string | null> = {
    VALUATION_BUCKET: null,
    QUALITY_BUCKET: null,
    MOMENTUM_BUCKET: null,
    GROWTH_BUCKET: null,
    LEVERAGE_BUCKET: null,
    SECTOR_FILTER: null,
  };
  for (const criterion of criteria.slice(0, 6)) {
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
      case "sector":
        params.SECTOR_FILTER = criterion.bucket;
        break;
    }
  }
  return params;
}

function stringifyCriteria(criteria: FactorBacktestCriterion[]): string {
  return criteria
    .map((item) => `${item.factor}:${item.bucket}`)
    .sort()
    .join(",");
}

function adequacyForSample(
  sampleSize: number,
): FactorBacktestView["sampleAdequacy"] {
  if (!Number.isFinite(sampleSize)) return "UNKNOWN";
  if (sampleSize < THIN_SAMPLE_THRESHOLD) return "THIN";
  if (sampleSize < ROBUST_SAMPLE_THRESHOLD) return "ADEQUATE";
  return "ROBUST";
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

function symbolListValue(value: unknown): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value
          .replace(/^\{|\}$/g, "")
          .split(",")
      : [];
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const item of rawItems) {
    const symbol = String(item ?? "")
      .replace(/^"|"$/g, "")
      .trim()
      .toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
  }
  return symbols.slice(0, 10);
}

function dateStringValue(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return stringValue(value);
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined && item !== null) out[key] = item;
  }
  return out as T;
}
