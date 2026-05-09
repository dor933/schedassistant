import { logger } from "../../logger";
import { numberValue, stringValue } from "../snapshotClient";
import type { StockIdeaRowView, StockIdeaView } from "../types";
import {
  buildResearchObjectCacheKey,
  buildResearchObjectsForAnchors,
} from "../researchObjectBuilder";
import { runPgCapabilityQuery } from "./queryClient";
import type {
  CapabilityFreshness,
  PgCapabilityRunInput,
  PgCapabilityRunResult,
  StockIdeaDiscoveryRow,
} from "./types";
import { assessCapabilityFreshness } from "./freshnessGuard";

const VIEW_SCHEMA_VERSION = 2;
const DEFAULT_MAX_ROWS = 10;
const MAX_ROWS_CAP = 20;
const DEFAULT_CANDIDATE_POOL_SIZE = 200;
const MAX_CANDIDATE_POOL_SIZE = 500;

export type IndustryLeadersOptions = {
  queryRunner?: (
    replacements: Record<string, unknown>,
  ) => Promise<StockIdeaDiscoveryRow[]>;
  maxRows?: number;
  candidatePoolSize?: number;
  now?: Date;
};

/**
 * Cache-key params for `industry_leaders`. Both the inferred ranking basis
 * and the target industry reorder/scope the view, so both go into the cache
 * key. Mirrors `sectorLeadersCacheKeyParams`.
 */
export function industryLeadersCacheKeyParams(
  input: PgCapabilityRunInput,
): { rankingBasis: StockIdeaView["rankingBasis"]; industry: string } {
  return {
    rankingBasis: inferRankingBasis(input.message),
    industry: targetIndustry(input) ?? "",
  };
}

export async function buildIndustryLeadersView(
  input: PgCapabilityRunInput,
  options: IndustryLeadersOptions = {},
): Promise<PgCapabilityRunResult> {
  const rankingBasis = inferRankingBasis(input.message);
  const industry = targetIndustry(input);
  if (!industry) {
    return {
      views: {
        stockIdeaView: unavailableView(rankingBasis, [
          "No industry was supplied for the industry-leaders capability.",
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
        stockIdeaView: unavailableView(rankingBasis, [
          "External PG warehouse is not configured for industry-leaders queries.",
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
      INDUSTRY_FILTER: industry,
    });
    const draft = rowsToView(rows, rankingBasis, industry, options.now);
    if (draft.state === "unavailable") {
      return { views: { stockIdeaView: draft }, warnings: [] };
    }
    const fanout = await fanOutStockResearchObjects(input, draft);
    return {
      views: { stockIdeaView: fanout.view },
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
    const message = "Industry leaders query failed.";
    logger.warn("Ask Grahamy PG capability failed", {
      capability: "industry_leaders",
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

async function fanOutStockResearchObjects(
  input: PgCapabilityRunInput,
  draft: StockIdeaView,
): Promise<{
  view: StockIdeaView;
  researchObjects: import("../types").CachedResearchObject[];
  researchObjectsUpdated: import("../types").CachedResearchObject[];
  stats: { hits: number; misses: number; writes: number } | undefined;
  warnings: string[];
}> {
  const symbols = draft.rows.map((row) => row.symbol);
  const builder = input.researchObjectBuilder ?? buildResearchObjectsForAnchors;
  // Also build the INDUSTRY research object alongside the per-stock ones so
  // the agent has the industry-level context when explaining the ranking.
  const industries = targetIndustry(input) ? [targetIndustry(input)!] : [];
  const result = await builder({
    symbols,
    industries,
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

function defaultQueryRunner(
  replacements: Record<string, unknown>,
): Promise<StockIdeaDiscoveryRow[]> {
  return runPgCapabilityQuery<StockIdeaDiscoveryRow>(
    "query_industry_leaders",
    replacements,
  );
}

function rowsToView(
  rows: StockIdeaDiscoveryRow[],
  rankingBasis: StockIdeaView["rankingBasis"],
  industry: string,
  now?: Date,
): StockIdeaView {
  if (!rows.length) {
    return unavailableView(rankingBasis, [
      `No leading-stock rows were available for ${industry} from the PG warehouse.`,
    ]);
  }

  const first = rows[0];
  const asOfDate = dateStringValue(first.as_of_date);
  const publicRows = rows
    .map((row) => rowToPublicRow(row, asOfDate))
    .filter((row): row is StockIdeaRowView => !!row);
  if (!publicRows.length) {
    return unavailableView(rankingBasis, [
      `No public-safe industry-leaders rows could be derived for ${industry}.`,
    ]);
  }

  const forwardOverlayAvailable = rows.some((row) =>
    boolValue(row.forward_overlay_available),
  );
  const freshnessAssessment = buildFreshness(first, asOfDate, now);
  const freshness = freshnessAssessment.publicFreshness;
  if (freshnessAssessment.decision === "unavailable") {
    return unavailableView(
      rankingBasis,
      [freshness.warning ?? `Industry-leaders data for ${industry} is stale.`],
      freshness,
    );
  }
  const warnings: string[] = [
    `Industry-internal ranking for ${industry}; rows are research candidates to review, not buy/sell recommendations.`,
    "Daily path-risk drawdown metrics are not yet bundled with this view.",
    "Conviction score is sector-relative (industry-level peer MV is not yet built); treat the conviction bucket as a cross-sector quality signal rather than an industry-internal ranking.",
  ];
  if (!forwardOverlayAvailable) {
    warnings.push(
      "Historical forward-return overlay is unavailable; rows are ranked from current PG features only.",
    );
  }
  if (freshness.state === "stale") {
    warnings.push(
      freshness.warning ??
        "This industry-leaders view uses stale data and should be treated as a snapshot.",
    );
  } else if (freshness.state === "unknown" && freshness.warning) {
    warnings.push(freshness.warning);
  }

  const researchObjectKeys = Array.from(
    new Set(publicRows.map((row) => row.researchObjectKey).filter(Boolean)),
  );

  return {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state: "partial",
    source: "pg_features_daily",
    asOfDate,
    rankingBasis,
    rows: publicRows,
    researchObjectKeys,
    freshness,
    warnings,
  };
}

function rowToPublicRow(
  row: StockIdeaDiscoveryRow,
  asOfDate: string | undefined,
): StockIdeaRowView | null {
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
    researchObjectKey: buildResearchObjectCacheKey(
      "STOCK",
      symbol,
      asOfDate ?? new Date().toISOString().slice(0, 10),
    ),
  };
}

function buildReasonBullets(
  row: Omit<StockIdeaRowView, "reasonBullets" | "researchObjectKey">,
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
  now?: Date,
): ReturnType<typeof assessCapabilityFreshness> {
  return assessCapabilityFreshness({
    capability: "industry_leaders",
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
        // Industry leaders still surface the sector-relative composite_pct so
        // we keep the peer MV freshness gauge here — when it goes stale the
        // conviction signal degrades (rows still rank by setup_score).
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
  rankingBasis: StockIdeaView["rankingBasis"],
  warnings: string[],
  freshness: CapabilityFreshness = { state: "unknown" },
): StockIdeaView {
  return {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state: "unavailable",
    source: "pg_features_daily",
    rankingBasis,
    rows: [],
    researchObjectKeys: [],
    freshness,
    warnings,
  };
}

function targetIndustry(input: PgCapabilityRunInput): string | undefined {
  const fromClassification = input.classification.industries[0];
  if (typeof fromClassification === "string" && fromClassification.trim()) {
    return fromClassification.trim();
  }
  return undefined;
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
