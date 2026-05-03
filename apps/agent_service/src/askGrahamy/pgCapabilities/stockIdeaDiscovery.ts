import { logger } from "../../logger";
import { numberValue, stringValue } from "../snapshotClient";
import type { StockIdeaRowView, StockIdeaView } from "../types";
import { runPgCapabilityQuery } from "./queryClient";
import type {
  CapabilityFreshness,
  PgCapabilityRunInput,
  PgCapabilityRunResult,
  StockIdeaDiscoveryRow,
} from "./types";

const VIEW_SCHEMA_VERSION = 1;
const DEFAULT_MAX_ROWS = 10;
const MAX_ROWS_CAP = 20;
const DEFAULT_CANDIDATE_POOL_SIZE = 200;
const MAX_CANDIDATE_POOL_SIZE = 500;

export type StockIdeaDiscoveryOptions = {
  queryRunner?: (
    replacements: Record<string, unknown>,
  ) => Promise<StockIdeaDiscoveryRow[]>;
  maxRows?: number;
  candidatePoolSize?: number;
};

export async function buildStockIdeaDiscoveryView(
  input: PgCapabilityRunInput,
  options: StockIdeaDiscoveryOptions = {},
): Promise<PgCapabilityRunResult> {
  const rankingBasis = inferRankingBasis(input.message);
  const maxRows = clamp(options.maxRows ?? DEFAULT_MAX_ROWS, 1, MAX_ROWS_CAP);
  const candidatePoolSize = clamp(
    options.candidatePoolSize ?? DEFAULT_CANDIDATE_POOL_SIZE,
    maxRows,
    MAX_CANDIDATE_POOL_SIZE,
  );

  if (!options.queryRunner && !isExternalPgConfigured()) {
    return {
      views: {
        stockIdeaView: unavailableView(rankingBasis, [
          "External PG warehouse is not configured for stock idea discovery.",
        ]),
      },
      warnings: [],
    };
  }

  try {
    const rows = await (options.queryRunner ?? defaultQueryRunner)({
      MAX_ROWS: maxRows,
      CANDIDATE_POOL_SIZE: candidatePoolSize,
      RANK_BY: rankingBasis,
    });
    const view = rowsToView(rows, rankingBasis);
    return { views: { stockIdeaView: view }, warnings: [] };
  } catch (err) {
    const message = "Stock idea discovery query failed.";
    logger.warn("Ask Grahamy PG capability failed", {
      capability: "stock_idea_discovery",
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      views: {
        stockIdeaView: unavailableView(rankingBasis, [message]),
      },
      warnings: [message],
    };
  }
}

function defaultQueryRunner(
  replacements: Record<string, unknown>,
): Promise<StockIdeaDiscoveryRow[]> {
  return runPgCapabilityQuery<StockIdeaDiscoveryRow>(
    "query_stock_idea_discovery",
    replacements,
  );
}

function rowsToView(
  rows: StockIdeaDiscoveryRow[],
  rankingBasis: StockIdeaView["rankingBasis"],
): StockIdeaView {
  if (!rows.length) {
    return unavailableView(rankingBasis, [
      "No stock idea discovery rows were available from the PG warehouse.",
    ]);
  }

  const first = rows[0];
  const publicRows = rows
    .map(rowToPublicRow)
    .filter((row): row is StockIdeaRowView => !!row);
  if (!publicRows.length) {
    return unavailableView(rankingBasis, [
      "No public-safe stock idea rows could be derived from the PG warehouse.",
    ]);
  }

  const forwardOverlayAvailable = rows.some((row) =>
    boolValue(row.forward_overlay_available),
  );
  const asOfDate = dateStringValue(first.as_of_date);
  const freshness = buildFreshness(first, asOfDate);
  const warnings: string[] = [
    "These are research candidates to review, not buy/sell recommendations.",
    "V1 stock idea discovery does not include daily path-risk drawdown metrics.",
  ];
  if (!forwardOverlayAvailable) {
    warnings.push(
      "Historical forward-return overlay is unavailable; rows are ranked from current PG features only.",
    );
  }
  if (freshness.state === "stale") {
    warnings.push("One or more PG stock idea discovery sources are stale.");
  }

  return {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state: "partial",
    source: "pg_features_daily",
    asOfDate,
    rankingBasis,
    rows: publicRows,
    freshness,
    warnings,
  };
}

function rowToPublicRow(row: StockIdeaDiscoveryRow): StockIdeaRowView | null {
  const symbol = stringValue(row.symbol)?.toUpperCase();
  const rank = integerValue(row.rank);
  if (!symbol || rank == null) return null;

  const publicRow = compactObject({
    symbol,
    companyName: stringValue(row.company_name),
    sector: stringValue(row.sector),
    rank,
    convictionScorePct: roundNumber(row.conviction_score_pct, 1),
    convictionBucket: stringValue(row.conviction_bucket),
    evidenceStrength: stringValue(row.evidence_strength),
    hitRatePct: roundNumber(row.hit_rate_pct, 1),
    medianReturnPct: roundNumber(row.median_return_pct, 2),
    p25ReturnPct: roundNumber(row.p25_return_pct, 2),
    p75ReturnPct: roundNumber(row.p75_return_pct, 2),
    momentumBucket: stringValue(row.momentum_bucket),
    qualityBucket: stringValue(row.quality_bucket),
    valuationBucket: stringValue(row.valuation_bucket),
    pathRiskBucket: stringValue(row.path_risk_bucket),
  });

  return {
    ...publicRow,
    reasonBullets: buildReasonBullets(publicRow),
  };
}

function buildReasonBullets(
  row: Omit<StockIdeaRowView, "reasonBullets">,
): string[] {
  const reasons: string[] = [];
  if (row.convictionBucket) {
    reasons.push(`Sector-relative conviction bucket is ${row.convictionBucket}.`);
  } else if (row.convictionScorePct != null) {
    reasons.push("Sector-relative conviction score is available from PG peer data.");
  }
  if (row.momentumBucket) {
    reasons.push(`Momentum bucket is ${row.momentumBucket}.`);
  }
  if (row.qualityBucket) {
    reasons.push(`Quality bucket is ${row.qualityBucket}.`);
  }
  if (row.valuationBucket) {
    reasons.push(`Valuation bucket is ${row.valuationBucket}.`);
  }
  if (row.hitRatePct != null) {
    reasons.push("Bounded self-history forward evidence is available.");
  } else {
    reasons.push("Historical forward-return overlay is not available for this row.");
  }
  if (row.pathRiskBucket) {
    reasons.push(row.pathRiskBucket);
  }
  return reasons.slice(0, 5);
}

function buildFreshness(
  row: StockIdeaDiscoveryRow,
  asOfDate: string | undefined,
): CapabilityFreshness {
  const sources = [
    {
      name: "md_features_daily",
      completedAt: dateTimeStringValue(row.features_completed_at),
      state: stringValue(row.features_freshness_state),
    },
    {
      name: "md_research_sector_peer_daily",
      completedAt: dateTimeStringValue(row.peer_completed_at),
      state: stringValue(row.peer_freshness_state),
    },
  ].filter((source) => source.completedAt || source.state);
  const states = sources.map((source) => source.state?.toUpperCase());
  const freshnessState =
    states.length === 0
      ? "unknown"
      : states.some((state) => state && state !== "FRESH")
        ? "stale"
        : "fresh";

  return {
    dataThrough: asOfDate,
    state: freshnessState,
    sources,
  };
}

function unavailableView(
  rankingBasis: StockIdeaView["rankingBasis"],
  warnings: string[],
): StockIdeaView {
  return {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state: "unavailable",
    source: "pg_features_daily",
    rankingBasis,
    rows: [],
    freshness: { state: "unknown" },
    warnings,
  };
}

function inferRankingBasis(message: string): StockIdeaView["rankingBasis"] {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("risk adjusted") ||
    normalized.includes("risk-adjusted") ||
    normalized.includes("risk")
  ) {
    return "risk_adjusted";
  }
  if (
    normalized.includes("historical forward") ||
    normalized.includes("forward profile") ||
    normalized.includes("base-rate") ||
    normalized.includes("base rate")
  ) {
    return "historical_forward";
  }
  if (
    normalized.includes("conviction") ||
    normalized.includes("top names") ||
    normalized.includes("top conviction")
  ) {
    return "conviction";
  }
  return "setup_quality";
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
