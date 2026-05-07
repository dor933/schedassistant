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
  SectorVsSectorComparisonRow,
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

export type SectorVsSectorComparisonOptions = {
  queryRunner?: (
    replacements: Record<string, unknown>,
  ) => Promise<SectorVsSectorComparisonRow[]>;
  now?: Date;
};

export function sectorVsSectorComparisonCacheKeyParams(
  input: PgCapabilityRunInput,
): { leftSector: string; rightSector: string } {
  const comparison = input.classification.comparison;
  if (comparison?.comparisonType !== "sector_vs_sector") {
    return { leftSector: "unsupported", rightSector: "unsupported" };
  }
  const left = resolveSector(comparison.left.sector);
  const right = resolveSector(comparison.right.sector);
  return {
    leftSector: left.sector ?? `invalid:${left.label}`,
    rightSector: right.sector ?? `invalid:${right.label}`,
  };
}

export function sectorVsSectorComparisonAnchors(
  input: PgCapabilityRunInput,
): { anchorSector?: string } {
  const comparison = input.classification.comparison;
  if (comparison?.comparisonType !== "sector_vs_sector") return {};
  const left = resolveSector(comparison.left.sector);
  return left.sector ? { anchorSector: left.sector } : {};
}

export async function buildSectorVsSectorComparisonView(
  input: PgCapabilityRunInput,
  options: SectorVsSectorComparisonOptions = {},
): Promise<PgCapabilityRunResult> {
  const comparison = input.classification.comparison;
  if (comparison?.comparisonType !== "sector_vs_sector") {
    return {
      views: {
        comparisonView: unavailableView("sector A", "sector B", [
          "Only sector-versus-sector comparisons are supported in this view.",
        ]),
      },
      warnings: [],
    };
  }

  const leftResolution = resolveSector(comparison.left.sector);
  const rightResolution = resolveSector(comparison.right.sector);
  const invalid = [leftResolution, rightResolution].filter((item) => item.invalid);
  if (invalid.length) {
    return {
      views: {
        comparisonView: unavailableView(
          leftResolution.label,
          rightResolution.label,
          [
            `Unsupported sector comparison anchor: ${invalid
              .map((item) => `"${item.label}"`)
              .join(", ")}.`,
          ],
        ),
      },
      warnings: [],
    };
  }

  if (leftResolution.sector === rightResolution.sector) {
    return {
      views: {
        comparisonView: unavailableView(
          leftResolution.sector,
          rightResolution.sector,
          ["Cannot compare a sector to itself."],
        ),
      },
      warnings: [],
    };
  }

  if (!options.queryRunner && !isExternalPgConfigured()) {
    return {
      views: {
        comparisonView: unavailableView(
          leftResolution.sector,
          rightResolution.sector,
          ["External PG warehouse is not configured for sector-versus-sector comparison."],
        ),
      },
      warnings: [],
    };
  }

  try {
    const rows = await (options.queryRunner ?? defaultQueryRunner)({
      LEFT_SECTOR: leftResolution.sector,
      RIGHT_SECTOR: rightResolution.sector,
    });
    const view = rowsToView(rows, leftResolution.sector, rightResolution.sector, options.now);
    return { views: { comparisonView: view }, warnings: [] };
  } catch (err) {
    const message = "Sector-versus-sector comparison query failed.";
    logger.warn("Ask Grahamy PG capability failed", {
      capability: "sector_vs_sector_comparison",
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      views: {
        comparisonView: unavailableView(leftResolution.sector, rightResolution.sector, [message]),
      },
      warnings: [message],
    };
  }
}

function defaultQueryRunner(
  replacements: Record<string, unknown>,
): Promise<SectorVsSectorComparisonRow[]> {
  return runPgCapabilityQuery<SectorVsSectorComparisonRow>(
    "query_sector_vs_sector_comparison",
    replacements,
  );
}

function rowsToView(
  rows: SectorVsSectorComparisonRow[],
  leftSector: string,
  rightSector: string,
  now?: Date,
): ComparisonView {
  if (!rows.length) {
    return unavailableView(leftSector, rightSector, [
      "No current PG sector rows were available for this comparison.",
    ]);
  }

  const row = rows[0];
  const leftFound = boolValue(row.left_sector_found);
  const rightFound = boolValue(row.right_sector_found);
  if (!leftFound || !rightFound) {
    const missing = [
      leftFound ? undefined : leftSector,
      rightFound ? undefined : rightSector,
    ].filter(Boolean);
    return unavailableView(leftSector, rightSector, [
      `No current public sector comparison row was available for ${missing.join(", ")}.`,
    ]);
  }

  const left: ComparisonSideView = {
    type: "sector",
    label: leftSector,
    sector: leftSector,
    metrics: compactObject({
      convictionScorePct: roundNumber(row.left_conviction_score_pct, 1),
      convictionBucket: stringValue(row.left_conviction_bucket),
      momentumBucket: stringValue(row.left_momentum_bucket),
      qualityBucket: stringValue(row.left_quality_bucket),
      growthBucket: stringValue(row.left_growth_bucket),
      leverageBucket: stringValue(row.left_leverage_bucket),
      hitRatePct: roundNumber(row.left_hit_rate_pct, 1),
    }),
  };

  const right: ComparisonSideView = {
    type: "sector",
    label: rightSector,
    sector: rightSector,
    metrics: compactObject({
      convictionScorePct: roundNumber(row.right_conviction_score_pct, 1),
      convictionBucket: stringValue(row.right_conviction_bucket),
      momentumBucket: stringValue(row.right_momentum_bucket),
      qualityBucket: stringValue(row.right_quality_bucket),
      growthBucket: stringValue(row.right_growth_bucket),
      leverageBucket: stringValue(row.right_leverage_bucket),
      hitRatePct: roundNumber(row.right_hit_rate_pct, 1),
    }),
  };

  const asOfDate = dateStringValue(row.as_of_date);
  const freshnessAssessment = buildFreshness(row, asOfDate, now);
  const freshness = freshnessAssessment.publicFreshness;
  if (freshnessAssessment.decision === "unavailable") {
    return unavailableView(
      leftSector,
      rightSector,
      [freshness.warning ?? "Sector-versus-sector comparison data is stale."],
      freshness,
      left,
      right,
    );
  }

  const deltas = buildDeltas(left, right);
  const warnings: string[] = [];
  if (!boolValue(row.left_forward_overlay_available)) {
    warnings.push(`${leftSector} historical forward-return overlay is unavailable for this comparison.`);
  }
  if (!boolValue(row.right_forward_overlay_available)) {
    warnings.push(`${rightSector} historical forward-return overlay is unavailable for this comparison.`);
  }
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
    comparisonType: "sector_vs_sector",
    source: "pg_sector_peer_daily",
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
    explanation: "Compares current public sector conviction scores.",
  });
  addBucketDelta(deltas, {
    metric: "momentum",
    leftValue: left.metrics.momentumBucket,
    rightValue: right.metrics.momentumBucket,
    explanation: "Compares public sector momentum buckets.",
  });
  addBucketDelta(deltas, {
    metric: "quality",
    leftValue: left.metrics.qualityBucket,
    rightValue: right.metrics.qualityBucket,
    explanation: "Compares public sector quality buckets.",
  });
  addBucketDelta(deltas, {
    metric: "growth",
    leftValue: left.metrics.growthBucket,
    rightValue: right.metrics.growthBucket,
    explanation: "Compares public sector growth buckets.",
  });
  addBucketDelta(deltas, {
    metric: "leverage",
    leftValue: left.metrics.leverageBucket,
    rightValue: right.metrics.leverageBucket,
    explanation: "Compares public sector balance-sheet/leverage buckets.",
  });
  addNumericDelta(deltas, {
    metric: "historical_forward",
    leftValue: left.metrics.hitRatePct,
    rightValue: right.metrics.hitRatePct,
    explanation: "Compares bounded 60-day positive-return hit-rate evidence where both sectors have it.",
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
      `Comparable public metrics are limited for ${left.label} versus ${right.label}.`,
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
    bullets.push(`${left.label} screens stronger than ${right.label} on ${joinLabels(leftStronger)}.`);
  }
  if (rightStronger.length) {
    bullets.push(`${right.label} screens stronger than ${left.label} on ${joinLabels(rightStronger)}.`);
  }
  if (similar.length) {
    bullets.push(`${left.label} and ${right.label} look similar on ${joinLabels(similar)}.`);
  }
  if (!bullets.length) {
    bullets.push(`The comparison is mixed for ${left.label} versus ${right.label}.`);
  }
  return bullets.slice(0, 4);
}

function buildFreshness(
  row: SectorVsSectorComparisonRow,
  asOfDate: string | undefined,
  now?: Date,
): ReturnType<typeof assessCapabilityFreshness> {
  return assessCapabilityFreshness({
    capability: "sector_vs_sector_comparison",
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
    comparisonType: "sector_vs_sector",
    source: "pg_sector_peer_daily",
    left: left ?? {
      type: "sector",
      label: leftLabel,
      sector: leftLabel,
      metrics: {},
    },
    right: right ?? {
      type: "sector",
      label: rightLabel,
      sector: rightLabel,
      metrics: {},
    },
    deltas: [],
    summaryBullets: [],
    freshness,
    warnings,
  };
}

type ResolvedSector = {
  sector: string;
  label: string;
  invalid: boolean;
};

function resolveSector(value: string | undefined): ResolvedSector {
  const raw = value?.trim() ?? "";
  if (!raw) return { sector: "", label: "sector", invalid: true };
  const canonical = canonicalSector(raw);
  if (!canonical) return { sector: raw, label: raw, invalid: true };
  return { sector: canonical, label: canonical, invalid: false };
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
