import { logger } from "../../logger";
import { numberValue, stringValue } from "../snapshotClient";
import type {
  ComparisonDeltaMetric,
  ComparisonDeltaView,
  ComparisonSideView,
  ComparisonView,
} from "../types";
import { assessCapabilityFreshness } from "./freshnessGuard";
import { runPgCapabilityQuery } from "./queryClient";
import type {
  CapabilityFreshness,
  PgCapabilityRunInput,
  PgCapabilityRunResult,
  SymbolVsSymbolComparisonRow,
} from "./types";

const VIEW_SCHEMA_VERSION = 1;

export type SymbolVsSymbolComparisonOptions = {
  queryRunner?: (
    replacements: Record<string, unknown>,
  ) => Promise<SymbolVsSymbolComparisonRow[]>;
  now?: Date;
};

export function symbolVsSymbolComparisonCacheKeyParams(
  input: PgCapabilityRunInput,
): { leftSymbol: string; rightSymbol: string } {
  const comparison = input.classification.comparison;
  if (comparison?.comparisonType !== "symbol_vs_symbol") {
    return { leftSymbol: "UNKNOWN", rightSymbol: "UNKNOWN" };
  }
  return {
    leftSymbol: normalizeSymbol(comparison.left.symbol) || "UNKNOWN",
    rightSymbol: normalizeSymbol(comparison.right.symbol) || "UNKNOWN",
  };
}

export function symbolVsSymbolComparisonAnchors(
  input: PgCapabilityRunInput,
): { anchorSymbol?: string } {
  const comparison = input.classification.comparison;
  if (comparison?.comparisonType !== "symbol_vs_symbol") return {};
  const anchorSymbol = normalizeSymbol(comparison.left.symbol);
  return anchorSymbol ? { anchorSymbol } : {};
}

export async function buildSymbolVsSymbolComparisonView(
  input: PgCapabilityRunInput,
  options: SymbolVsSymbolComparisonOptions = {},
): Promise<PgCapabilityRunResult> {
  const comparison = input.classification.comparison;
  if (comparison?.comparisonType !== "symbol_vs_symbol") {
    return {
      views: {
        comparisonView: unavailableView("symbol A", "symbol B", [
          "Only stock-versus-stock symbol comparisons are supported in this view.",
        ]),
      },
      warnings: [],
    };
  }

  const leftSymbol = normalizeSymbol(comparison.left.symbol);
  const rightSymbol = normalizeSymbol(comparison.right.symbol);
  if (!leftSymbol || !rightSymbol) {
    return {
      views: {
        comparisonView: unavailableView(leftSymbol || "missing symbol", rightSymbol || "missing symbol", [
          "Two valid stock symbols are required for symbol-versus-symbol comparison.",
        ]),
      },
      warnings: [],
    };
  }
  if (leftSymbol === rightSymbol) {
    return {
      views: {
        comparisonView: unavailableView(leftSymbol, rightSymbol, [
          "Cannot compare a symbol to itself.",
        ]),
      },
      warnings: [],
    };
  }

  if (!options.queryRunner && !isExternalPgConfigured()) {
    return {
      views: {
        comparisonView: unavailableView(leftSymbol, rightSymbol, [
          "External PG warehouse is not configured for symbol-versus-symbol comparison.",
        ]),
      },
      warnings: [],
    };
  }

  try {
    const rows = await (options.queryRunner ?? defaultQueryRunner)({
      LEFT_SYMBOL: leftSymbol,
      RIGHT_SYMBOL: rightSymbol,
    });
    const view = rowsToView(rows, leftSymbol, rightSymbol, options.now);
    return { views: { comparisonView: view }, warnings: [] };
  } catch (err) {
    const message = "Symbol-versus-symbol comparison query failed.";
    logger.warn("Ask Grahamy PG capability failed", {
      capability: "symbol_vs_symbol_comparison",
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      views: {
        comparisonView: unavailableView(leftSymbol, rightSymbol, [message]),
      },
      warnings: [message],
    };
  }
}

function defaultQueryRunner(
  replacements: Record<string, unknown>,
): Promise<SymbolVsSymbolComparisonRow[]> {
  return runPgCapabilityQuery<SymbolVsSymbolComparisonRow>(
    "query_symbol_vs_symbol_comparison",
    replacements,
  );
}

function rowsToView(
  rows: SymbolVsSymbolComparisonRow[],
  requestedLeftSymbol: string,
  requestedRightSymbol: string,
  now?: Date,
): ComparisonView {
  if (!rows.length) {
    return unavailableView(requestedLeftSymbol, requestedRightSymbol, [
      "No current PG feature rows were available for this symbol comparison.",
    ]);
  }

  const row = rows[0];
  const leftFound = boolValue(row.left_symbol_found);
  const rightFound = boolValue(row.right_symbol_found);
  if (!leftFound || !rightFound) {
    const missing = [
      leftFound ? undefined : requestedLeftSymbol,
      rightFound ? undefined : requestedRightSymbol,
    ].filter(Boolean);
    return unavailableView(requestedLeftSymbol, requestedRightSymbol, [
      `No current public stock comparison row was available for ${missing.join(", ")}.`,
    ]);
  }

  const leftSymbol = stringValue(row.left_symbol)?.toUpperCase() ?? requestedLeftSymbol;
  const rightSymbol = stringValue(row.right_symbol)?.toUpperCase() ?? requestedRightSymbol;
  const leftCompany = stringValue(row.left_company_name);
  const rightCompany = stringValue(row.right_company_name);
  const leftSector = stringValue(row.left_sector);
  const rightSector = stringValue(row.right_sector);

  const left: ComparisonSideView = {
    type: "stock",
    label: leftCompany ? `${leftSymbol} (${leftCompany})` : leftSymbol,
    symbol: leftSymbol,
    sector: leftSector,
    metrics: compactObject({
      convictionScorePct: roundNumber(row.left_conviction_score_pct, 1),
      convictionBucket: stringValue(row.left_conviction_bucket),
      valuationBucket: stringValue(row.left_valuation_bucket),
      momentumBucket: stringValue(row.left_momentum_bucket),
      qualityBucket: stringValue(row.left_quality_bucket),
      growthBucket: stringValue(row.left_growth_bucket),
      leverageBucket: stringValue(row.left_leverage_bucket),
      hitRatePct: roundNumber(row.left_hit_rate_pct, 1),
      medianReturnPct: roundNumber(row.left_median_return_pct, 2),
    }),
  };

  const right: ComparisonSideView = {
    type: "stock",
    label: rightCompany ? `${rightSymbol} (${rightCompany})` : rightSymbol,
    symbol: rightSymbol,
    sector: rightSector,
    metrics: compactObject({
      convictionScorePct: roundNumber(row.right_conviction_score_pct, 1),
      convictionBucket: stringValue(row.right_conviction_bucket),
      valuationBucket: stringValue(row.right_valuation_bucket),
      momentumBucket: stringValue(row.right_momentum_bucket),
      qualityBucket: stringValue(row.right_quality_bucket),
      growthBucket: stringValue(row.right_growth_bucket),
      leverageBucket: stringValue(row.right_leverage_bucket),
      hitRatePct: roundNumber(row.right_hit_rate_pct, 1),
      medianReturnPct: roundNumber(row.right_median_return_pct, 2),
    }),
  };

  const asOfDate = dateStringValue(row.as_of_date);
  const freshnessAssessment = buildFreshness(row, asOfDate, now);
  const freshness = freshnessAssessment.publicFreshness;
  if (freshnessAssessment.decision === "unavailable") {
    return unavailableView(
      leftSymbol,
      rightSymbol,
      [freshness.warning ?? "Symbol-versus-symbol comparison data is stale."],
      freshness,
      left,
      right,
    );
  }

  const deltas = buildDeltas(left, right);
  const warnings: string[] = [];
  if (leftSector && rightSector && leftSector !== rightSector) {
    warnings.push(
      "These companies are in different sectors, so sector-relative metrics are not one-for-one.",
    );
  }
  if (!boolValue(row.left_forward_overlay_available)) {
    warnings.push(`${leftSymbol} historical forward-return overlay is unavailable for this comparison.`);
  }
  if (!boolValue(row.right_forward_overlay_available)) {
    warnings.push(`${rightSymbol} historical forward-return overlay is unavailable for this comparison.`);
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
    comparisonType: "symbol_vs_symbol",
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
    explanation: "Compares current public stock conviction scores.",
  });
  addBucketDelta(deltas, {
    metric: "valuation",
    leftValue: left.metrics.valuationBucket,
    rightValue: right.metrics.valuationBucket,
    explanation: "Compares public valuation buckets for both stocks.",
  });
  addBucketDelta(deltas, {
    metric: "momentum",
    leftValue: left.metrics.momentumBucket,
    rightValue: right.metrics.momentumBucket,
    explanation: "Compares public momentum buckets for both stocks.",
  });
  addBucketDelta(deltas, {
    metric: "quality",
    leftValue: left.metrics.qualityBucket,
    rightValue: right.metrics.qualityBucket,
    explanation: "Compares public quality buckets for both stocks.",
  });
  addBucketDelta(deltas, {
    metric: "growth",
    leftValue: left.metrics.growthBucket,
    rightValue: right.metrics.growthBucket,
    explanation: "Compares public growth buckets for both stocks.",
  });
  addBucketDelta(deltas, {
    metric: "leverage",
    leftValue: left.metrics.leverageBucket,
    rightValue: right.metrics.leverageBucket,
    explanation: "Compares public balance-sheet/leverage buckets for both stocks.",
  });
  addNumericDelta(deltas, {
    metric: "historical_forward",
    leftValue: left.metrics.hitRatePct,
    rightValue: right.metrics.hitRatePct,
    explanation: "Compares bounded 60-day positive-return hit-rate evidence where both stocks have it.",
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
      `Comparable public metrics are limited for ${left.symbol ?? left.label} versus ${right.symbol ?? right.label}.`,
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

  const leftLabel = left.symbol ?? left.label;
  const rightLabel = right.symbol ?? right.label;
  const bullets: string[] = [];
  if (leftStronger.length) {
    bullets.push(`${leftLabel} screens stronger than ${rightLabel} on ${joinLabels(leftStronger)}.`);
  }
  if (rightStronger.length) {
    bullets.push(`${rightLabel} screens stronger than ${leftLabel} on ${joinLabels(rightStronger)}.`);
  }
  if (similar.length) {
    bullets.push(`${leftLabel} and ${rightLabel} look similar on ${joinLabels(similar)}.`);
  }
  if (!bullets.length) {
    bullets.push(`The comparison is mixed for ${leftLabel} versus ${rightLabel}.`);
  }
  return bullets.slice(0, 4);
}

function buildFreshness(
  row: SymbolVsSymbolComparisonRow,
  asOfDate: string | undefined,
  now?: Date,
): ReturnType<typeof assessCapabilityFreshness> {
  return assessCapabilityFreshness({
    capability: "symbol_vs_symbol_comparison",
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
      {
        sourceId: "forward_returns",
        tableOrView: "md_forward_returns",
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
    comparisonType: "symbol_vs_symbol",
    source: "pg_current_features",
    left: left ?? {
      type: "stock",
      label: leftLabel,
      symbol: leftLabel.toUpperCase(),
      metrics: {},
    },
    right: right ?? {
      type: "stock",
      label: rightLabel,
      symbol: rightLabel.toUpperCase(),
      metrics: {},
    },
    deltas: [],
    summaryBullets: [],
    freshness,
    warnings,
  };
}

function normalizeSymbol(value: string | undefined): string {
  const symbol = value?.trim().toUpperCase() ?? "";
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) return "";
  return symbol;
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

function compactObject<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as T;
}
