import { logger } from "../../logger";
import { numberValue, stringValue } from "../snapshotClient";
import type { SectorLeaderboardRowView, SectorLeaderboardView } from "../types";
import { runPgCapabilityQuery } from "./queryClient";
import type {
  CapabilityFreshness,
  PgCapabilityRunInput,
  PgCapabilityRunResult,
  SectorConvictionLeaderboardRow,
} from "./types";
import { assessCapabilityFreshness } from "./freshnessGuard";

const VIEW_SCHEMA_VERSION = 1;
const DEFAULT_MAX_ROWS = 10;
const MAX_ROWS_CAP = 20;

export type SectorConvictionLeaderboardOptions = {
  queryRunner?: (
    replacements: Record<string, unknown>,
  ) => Promise<SectorConvictionLeaderboardRow[]>;
  maxRows?: number;
  now?: Date;
};

export async function buildSectorConvictionLeaderboardView(
  input: PgCapabilityRunInput,
  options: SectorConvictionLeaderboardOptions = {},
): Promise<PgCapabilityRunResult> {
  const rankingBasis = inferRankingBasis(input.message);
  const maxRows = clampMaxRows(options.maxRows ?? DEFAULT_MAX_ROWS);

  if (!options.queryRunner && !isExternalPgConfigured()) {
    return {
      views: {
        sectorLeaderboardView: unavailableView(rankingBasis, [
          "External PG warehouse is not configured for sector leaderboard queries.",
        ]),
      },
      warnings: [],
    };
  }

  try {
    const rows = await (options.queryRunner ?? defaultQueryRunner)({
      MAX_ROWS: maxRows,
      RANK_BY: rankingBasis,
    });
    const view = rowsToView(rows, rankingBasis, options.now);
    return { views: { sectorLeaderboardView: view }, warnings: [] };
  } catch (err) {
    const message = "Sector conviction leaderboard query failed.";
    logger.warn("Ask Grahamy PG capability failed", {
      capability: "sector_conviction_leaderboard",
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      views: {
        sectorLeaderboardView: unavailableView(rankingBasis, [message]),
      },
      warnings: [message],
    };
  }
}

function defaultQueryRunner(
  replacements: Record<string, unknown>,
): Promise<SectorConvictionLeaderboardRow[]> {
  return runPgCapabilityQuery<SectorConvictionLeaderboardRow>(
    "query_sector_conviction_leaderboard",
    replacements,
  );
}

function rowsToView(
  rows: SectorConvictionLeaderboardRow[],
  rankingBasis: SectorLeaderboardView["rankingBasis"],
  now?: Date,
): SectorLeaderboardView {
  if (!rows.length) {
    return unavailableView(rankingBasis, [
      "No sector leaderboard rows were available from the PG warehouse.",
    ]);
  }

  const first = rows[0];
  const publicRows = rows
    .map(rowToPublicRow)
    .filter((row): row is SectorLeaderboardRowView => !!row);
  if (!publicRows.length) {
    return unavailableView(rankingBasis, [
      "No public-safe sector leaderboard rows could be derived from the PG warehouse.",
    ]);
  }
  const overlayAvailable = rows.some((row) => boolValue(row.overlay_available));
  const asOfDate = dateStringValue(first.as_of_date);
  const warnings: string[] = [];
  if (!overlayAvailable) {
    warnings.push(
      "Historical forward-return overlay is unavailable; ranking uses current PG sector composite only.",
    );
  }

  const freshnessAssessment = buildFreshness(first, asOfDate, now);
  const freshness = freshnessAssessment.publicFreshness;
  if (freshnessAssessment.decision === "unavailable") {
    return unavailableView(
      rankingBasis,
      [freshness.warning ?? "Sector leaderboard data is stale."],
      freshness,
    );
  }
  if (freshness.state === "stale") {
    warnings.push(
      freshness.warning ??
        "This sector leaderboard uses stale data and should be treated as a snapshot.",
    );
  } else if (freshness.state === "unknown" && freshness.warning) {
    warnings.push(freshness.warning);
  }

  return {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state: overlayAvailable ? "complete" : "partial",
    source: "pg_sector_peer_daily",
    period: "latest",
    rankingBasis,
    asOfDate,
    rows: publicRows,
    freshness,
    warnings,
  };
}

function rowToPublicRow(
  row: SectorConvictionLeaderboardRow,
): SectorLeaderboardRowView | null {
  const sector = stringValue(row.sector);
  const rank = integerValue(row.rank);
  if (!sector || rank == null) return null;

  return compactObject({
    sector,
    rank,
    convictionScorePct: roundNumber(row.conviction_score_pct, 1),
    convictionBucket: stringValue(row.conviction_bucket),
    evidenceStrength: stringValue(row.evidence_strength),
    hitRatePct: roundNumber(row.hit_rate_pct, 1),
    momentumBucket: stringValue(row.momentum_bucket),
    priceMomentumSeparation: stringValue(row.price_momentum_separation),
    defensiveCyclicalLabel: stringValue(row.defensive_cyclical_label),
  });
}

function buildFreshness(
  row: SectorConvictionLeaderboardRow,
  asOfDate: string | undefined,
  now?: Date,
): ReturnType<typeof assessCapabilityFreshness> {
  return assessCapabilityFreshness({
    capability: "sector_conviction_leaderboard",
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
  rankingBasis: SectorLeaderboardView["rankingBasis"],
  warnings: string[],
  freshness: CapabilityFreshness = { state: "unknown" },
): SectorLeaderboardView {
  return {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state: "unavailable",
    source: "pg_sector_peer_daily",
    period: "latest",
    rankingBasis,
    rows: [],
    freshness,
    warnings,
  };
}

function inferRankingBasis(
  message: string,
): SectorLeaderboardView["rankingBasis"] {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("weak price") ||
    normalized.includes("weak momentum") ||
    normalized.includes("divergence") ||
    normalized.includes("price action")
  ) {
    return "divergence";
  }
  if (
    normalized.includes("historical forward") ||
    normalized.includes("forward profile") ||
    normalized.includes("base-rate") ||
    normalized.includes("base rate")
  ) {
    return "historical_forward";
  }
  return "conviction";
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
