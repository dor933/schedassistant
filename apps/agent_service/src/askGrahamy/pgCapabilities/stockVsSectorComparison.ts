import { logger } from "../../logger";
import { numberValue, stringValue } from "../snapshotClient";
import type {
  ComparisonDeltaMetric,
  ComparisonDeltaView,
  ComparisonSideView,
  ComparisonView,
  PublicFreshnessView,
} from "../types";
import { assessCapabilityFreshness } from "./freshnessGuard";
import { runPgCapabilityQuery } from "./queryClient";
import type {
  CapabilityFreshness,
  PgCapabilityRunInput,
  PgCapabilityRunResult,
  StockVsSectorComparisonRow,
} from "./types";

const VIEW_SCHEMA_VERSION = 1;

const CANONICAL_SECTORS = [
  "Technology",
  "Healthcare",
  "Energy",
  "Financial Services",
  "Industrials",
  "Basic Materials",
  "Utilities",
  "Consumer Defensive",
  "Consumer Cyclical",
  "Communication Services",
  "Real Estate",
  "Semiconductors",
] as const;

export type StockVsSectorComparisonOptions = {
  queryRunner?: (
    replacements: Record<string, unknown>,
  ) => Promise<StockVsSectorComparisonRow[]>;
  now?: Date;
};

/**
 * Cache-key params for `stock_vs_sector_comparison`. The view is anchored to
 * `(left.symbol, right.sector)` — both must go in the key. Implicit-sector
 * requests share a row across callers (PG resolves the sector deterministically
 * from the symbol). Invalid-sector requests get their own key so we cache
 * the "unsupported sector" answer instead of re-running the SQL.
 */
export function stockVsSectorComparisonCacheKeyParams(
  input: PgCapabilityRunInput,
): { leftSymbol: string; rightSector: string } {
  const comparison = input.classification.comparison;
  if (comparison?.comparisonType !== "stock_vs_sector") {
    return { leftSymbol: "UNKNOWN", rightSector: "unsupported" };
  }
  const leftSymbol = comparison.left.symbol.trim().toUpperCase() || "UNKNOWN";
  const sectorResolution = resolveRequestedSector(comparison.right);
  if (comparison.right.type === "implicit_stock_sector") {
    return { leftSymbol, rightSector: "implicit" };
  }
  if (sectorResolution.invalidSector) {
    return { leftSymbol, rightSector: `invalid:${sectorResolution.label}` };
  }
  return { leftSymbol, rightSector: sectorResolution.sector ?? sectorResolution.label };
}

/** Anchor extractors used by the orchestrator when persisting cache rows. */
export function stockVsSectorComparisonAnchors(
  input: PgCapabilityRunInput,
): { anchorSymbol?: string; anchorSector?: string } {
  const comparison = input.classification.comparison;
  if (comparison?.comparisonType !== "stock_vs_sector") return {};
  const anchorSymbol = comparison.left.symbol.trim().toUpperCase() || undefined;
  if (comparison.right.type === "implicit_stock_sector") {
    return { anchorSymbol };
  }
  const sectorResolution = resolveRequestedSector(comparison.right);
  if (sectorResolution.invalidSector) {
    return { anchorSymbol };
  }
  return { anchorSymbol, anchorSector: sectorResolution.sector };
}

export async function buildStockVsSectorComparisonView(
  input: PgCapabilityRunInput,
  options: StockVsSectorComparisonOptions = {},
): Promise<PgCapabilityRunResult> {
  const comparison = input.classification.comparison;
  if (comparison?.comparisonType !== "stock_vs_sector") {
    return {
      views: {
        comparisonView: unavailableView(
          "Unknown stock",
          "its sector",
          ["Only stock-versus-sector comparisons are supported in this view."],
        ),
      },
      warnings: [],
    };
  }

  const symbol = comparison.left.symbol.trim().toUpperCase();
  const sectorResolution = resolveRequestedSector(comparison.right);
  if (sectorResolution.invalidSector) {
    return {
      views: {
        comparisonView: unavailableView(symbol, sectorResolution.label, [
          `The sector "${sectorResolution.label}" is not supported for stock-versus-sector comparison.`,
        ]),
      },
      warnings: [],
    };
  }

  if (!options.queryRunner && !isExternalPgConfigured()) {
    return {
      views: {
        comparisonView: unavailableView(symbol, sectorResolution.label, [
          "External PG warehouse is not configured for stock-versus-sector comparison.",
        ]),
      },
      warnings: [],
    };
  }

  try {
    const rows = await (options.queryRunner ?? defaultQueryRunner)({
      SYMBOL: symbol,
      SECTOR: sectorResolution.sector ?? "",
    });
    const view = rowsToView(rows, symbol, sectorResolution, options.now);
    return { views: { comparisonView: view }, warnings: [] };
  } catch (err) {
    const message = "Stock-versus-sector comparison query failed.";
    logger.warn("Ask Grahamy PG capability failed", {
      capability: "stock_vs_sector_comparison",
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      views: {
        comparisonView: unavailableView(symbol, sectorResolution.label, [message]),
      },
      warnings: [message],
    };
  }
}

function defaultQueryRunner(
  replacements: Record<string, unknown>,
): Promise<StockVsSectorComparisonRow[]> {
  return runPgCapabilityQuery<StockVsSectorComparisonRow>(
    "query_stock_vs_sector_comparison",
    replacements,
  );
}

function rowsToView(
  rows: StockVsSectorComparisonRow[],
  requestedSymbol: string,
  sectorResolution: ResolvedSectorRequest,
  now?: Date,
): ComparisonView {
  if (!rows.length) {
    return unavailableView(requestedSymbol, sectorResolution.label, [
      `No current PG feature row was available for ${requestedSymbol}.`,
    ]);
  }

  const row = rows[0];
  const symbol = stringValue(row.symbol)?.toUpperCase() ?? requestedSymbol;
  const resolvedSector = stringValue(row.resolved_sector);
  const stockSector = stringValue(row.stock_sector);
  const companyName = stringValue(row.company_name);
  const comparisonSectorFound = boolValue(row.comparison_sector_found);

  if (!resolvedSector || !comparisonSectorFound) {
    return unavailableView(symbol, sectorResolution.label, [
      stockSector
        ? `No current public sector comparison row was available for ${sectorResolution.label}.`
        : `The current PG stock row for ${symbol} does not include a sector, so "its sector" cannot be resolved.`,
    ]);
  }

  const left: ComparisonSideView = {
    type: "stock",
    label: companyName ? `${symbol} (${companyName})` : symbol,
    symbol,
    sector: stockSector,
    metrics: compactObject({
      convictionScorePct: roundNumber(row.stock_conviction_score_pct, 1),
      convictionBucket: stringValue(row.stock_conviction_bucket),
      valuationBucket: stringValue(row.stock_valuation_bucket),
      momentumBucket: stringValue(row.stock_momentum_bucket),
      qualityBucket: stringValue(row.stock_quality_bucket),
      growthBucket: stringValue(row.stock_growth_bucket),
      leverageBucket: stringValue(row.stock_leverage_bucket),
      hitRatePct: roundNumber(row.stock_hit_rate_pct, 1),
      medianReturnPct: roundNumber(row.stock_median_return_pct, 2),
    }),
  };

  const right: ComparisonSideView = {
    type: "sector",
    label: resolvedSector,
    sector: resolvedSector,
    metrics: compactObject({
      convictionScorePct: roundNumber(row.sector_conviction_score_pct, 1),
      convictionBucket: stringValue(row.sector_conviction_bucket),
      momentumBucket: stringValue(row.sector_momentum_bucket),
      qualityBucket: stringValue(row.sector_quality_bucket),
      growthBucket: stringValue(row.sector_growth_bucket),
      leverageBucket: stringValue(row.sector_leverage_bucket),
      hitRatePct: roundNumber(row.sector_hit_rate_pct, 1),
    }),
  };

  const deltas = buildDeltas(left, right);
  const asOfDate = dateStringValue(row.as_of_date);
  const freshnessAssessment = buildFreshness(row, asOfDate, now);
  const freshness = freshnessAssessment.publicFreshness;
  if (freshnessAssessment.decision === "unavailable") {
    return unavailableView(
      symbol,
      resolvedSector,
      [freshness.warning ?? "Stock-versus-sector comparison data is stale."],
      freshness,
      left,
      right,
    );
  }

  const warnings: string[] = [];
  if (
    sectorResolution.sector &&
    stockSector &&
    sectorResolution.sector !== stockSector
  ) {
    warnings.push(
      `${symbol}'s current PG sector is ${stockSector}; this compares it against the explicitly requested ${sectorResolution.sector} sector.`,
    );
  }
  if (!boolValue(row.stock_forward_overlay_available)) {
    warnings.push("Stock historical forward-return overlay is unavailable for this comparison.");
  }
  if (!boolValue(row.sector_forward_overlay_available)) {
    warnings.push("Sector historical forward-return overlay is unavailable for this comparison.");
  }
  if (!left.metrics.valuationBucket || !right.metrics.valuationBucket) {
    warnings.push("Valuation is shown only where public-safe comparable buckets are available.");
  }
  warnings.push("Daily path-risk comparison is unavailable in V1; no drawdown numbers are inferred.");
  if (freshness.state === "stale") {
    warnings.push(
      freshness.warning ??
        "This comparison uses stale data and should be treated as a snapshot.",
    );
  } else if (freshness.state === "unknown" && freshness.warning) {
    warnings.push(freshness.warning);
  }

  return {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state: warnings.length ? "partial" : "complete",
    comparisonType: "stock_vs_sector",
    source: "pg_current_features",
    asOfDate,
    left,
    right,
    deltas,
    summaryBullets: buildSummaryBullets(left, right, deltas),
    freshness,
    warnings,
  };
}

function buildDeltas(
  left: ComparisonSideView,
  right: ComparisonSideView,
): ComparisonDeltaView[] {
  const deltas: ComparisonDeltaView[] = [];

  addNumericDelta(deltas, {
    metric: "conviction",
    leftValue: left.metrics.convictionScorePct,
    rightValue: right.metrics.convictionScorePct,
    explanation: "Compares the stock's current sector-relative conviction score with the sector aggregate.",
  });
  addBucketDelta(deltas, {
    metric: "momentum",
    leftValue: left.metrics.momentumBucket,
    rightValue: right.metrics.momentumBucket,
    explanation: "Compares public momentum buckets for the stock and sector.",
  });
  addBucketDelta(deltas, {
    metric: "quality",
    leftValue: left.metrics.qualityBucket,
    rightValue: right.metrics.qualityBucket,
    explanation: "Compares public quality buckets for the stock and sector.",
  });
  addBucketDelta(deltas, {
    metric: "growth",
    leftValue: left.metrics.growthBucket,
    rightValue: right.metrics.growthBucket,
    explanation: "Compares public growth buckets for the stock and sector.",
  });
  addBucketDelta(deltas, {
    metric: "leverage",
    leftValue: left.metrics.leverageBucket,
    rightValue: right.metrics.leverageBucket,
    explanation: "Compares public balance-sheet/leverage buckets for the stock and sector.",
  });
  addNumericDelta(deltas, {
    metric: "historical_forward",
    leftValue: left.metrics.hitRatePct,
    rightValue: right.metrics.hitRatePct,
    explanation: "Compares bounded 60-day positive-return hit-rate evidence where both sides have it.",
  });

  return deltas;
}

function addNumericDelta(
  deltas: ComparisonDeltaView[],
  input: {
    metric: ComparisonDeltaMetric;
    leftValue?: number;
    rightValue?: number;
    explanation: string;
  },
): void {
  if (input.leftValue == null || input.rightValue == null) return;
  const delta = roundPlain(input.leftValue - input.rightValue, 1);
  deltas.push({
    metric: input.metric,
    leftValue: input.leftValue,
    rightValue: input.rightValue,
    delta,
    interpretationBucket:
      Math.abs(delta) < 3
        ? "similar"
        : delta > 0
          ? "left_stronger"
          : "right_stronger",
    explanation: input.explanation,
  });
}

function addBucketDelta(
  deltas: ComparisonDeltaView[],
  input: {
    metric: ComparisonDeltaMetric;
    leftValue?: string;
    rightValue?: string;
    explanation: string;
  },
): void {
  if (!input.leftValue || !input.rightValue) return;
  const leftRank = bucketRank(input.leftValue);
  const rightRank = bucketRank(input.rightValue);
  deltas.push({
    metric: input.metric,
    leftValue: input.leftValue,
    rightValue: input.rightValue,
    interpretationBucket:
      leftRank == null || rightRank == null
        ? "mixed"
        : leftRank === rightRank
          ? "similar"
          : leftRank > rightRank
            ? "left_stronger"
            : "right_stronger",
    explanation: input.explanation,
  });
}

function buildSummaryBullets(
  left: ComparisonSideView,
  right: ComparisonSideView,
  deltas: ComparisonDeltaView[],
): string[] {
  if (!deltas.length) {
    return [
      `Comparable public metrics are limited for ${left.symbol ?? left.label} versus ${right.label}.`,
    ];
  }

  const leftStronger = deltas
    .filter((delta) => delta.interpretationBucket === "left_stronger")
    .map((delta) => metricLabel(delta.metric));
  const rightStronger = deltas
    .filter((delta) => delta.interpretationBucket === "right_stronger")
    .map((delta) => metricLabel(delta.metric));
  const similar = deltas
    .filter((delta) => delta.interpretationBucket === "similar")
    .map((delta) => metricLabel(delta.metric));

  const bullets: string[] = [];
  if (leftStronger.length) {
    bullets.push(`${left.symbol ?? left.label} screens stronger than ${right.label} on ${joinLabels(leftStronger)}.`);
  }
  if (rightStronger.length) {
    bullets.push(`${right.label} screens stronger than ${left.symbol ?? left.label} on ${joinLabels(rightStronger)}.`);
  }
  if (similar.length) {
    bullets.push(`${left.symbol ?? left.label} and ${right.label} look similar on ${joinLabels(similar)}.`);
  }
  if (!bullets.length) {
    bullets.push(`The comparison is mixed for ${left.symbol ?? left.label} versus ${right.label}.`);
  }
  return bullets.slice(0, 4);
}

function buildFreshness(
  row: StockVsSectorComparisonRow,
  asOfDate: string | undefined,
  now?: Date,
): ReturnType<typeof assessCapabilityFreshness> {
  return assessCapabilityFreshness({
    capability: "stock_vs_sector_comparison",
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
  leftLabel: string,
  rightLabel: string,
  warnings: string[],
  freshness: CapabilityFreshness = { state: "unknown" },
  left?: ComparisonSideView,
  right?: ComparisonSideView,
): ComparisonView {
  return {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state: "unavailable",
    comparisonType: "stock_vs_sector",
    source: "pg_current_features",
    left: left ?? {
      type: "stock",
      label: leftLabel,
      symbol: leftLabel.toUpperCase(),
      metrics: {},
    },
    right: right ?? {
      type: "sector",
      label: rightLabel,
      ...(rightLabel !== "its sector" ? { sector: rightLabel } : {}),
      metrics: {},
    },
    deltas: [],
    summaryBullets: [],
    freshness,
    warnings,
  };
}

type ResolvedSectorRequest = {
  sector?: string;
  label: string;
  invalidSector: boolean;
};

type StockVsSectorRight =
  | { type: "sector"; sector?: string }
  | { type: "implicit_stock_sector" };

function resolveRequestedSector(
  right: StockVsSectorRight,
): ResolvedSectorRequest {
  if (right.type === "implicit_stock_sector") {
    return { label: "its sector", invalidSector: false };
  }
  const raw = right.sector?.trim();
  if (!raw) {
    return { label: "explicit sector", invalidSector: true };
  }
  const canonical = canonicalSector(raw);
  if (!canonical) {
    return { label: raw, invalidSector: true };
  }
  return { sector: canonical, label: canonical, invalidSector: false };
}

function canonicalSector(value: string): string | undefined {
  const normalized = normalizeLabel(value);
  return CANONICAL_SECTORS.find((sector) => normalizeLabel(sector) === normalized);
}

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function bucketRank(value: string): number | undefined {
  const normalized = value.toUpperCase();
  if (normalized === "WEAK" || normalized === "RICH") return 1;
  if (normalized === "MIXED" || normalized === "FAIR") return 2;
  if (normalized === "CONSTRUCTIVE" || normalized === "ATTRACTIVE") return 3;
  if (normalized === "STRONG" || normalized === "HIGH") return 4;
  return undefined;
}

function metricLabel(metric: ComparisonDeltaMetric): string {
  switch (metric) {
    case "historical_forward":
      return "historical forward hit-rate evidence";
    case "path_risk":
      return "path risk";
    default:
      return metric.replace(/_/g, " ");
  }
}

function joinLabels(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function isExternalPgConfigured(): boolean {
  return Boolean(process.env.EXTERNAL_PG_HOST && process.env.EXTERNAL_PG_DATABASE);
}

function roundNumber(value: unknown, decimals: number): number | undefined {
  const parsed = numericValue(value);
  if (parsed == null || !Number.isFinite(parsed)) return undefined;
  return roundPlain(parsed, decimals);
}

function roundPlain(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
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
