import { logger } from "../../logger";
import { numberValue, stringValue } from "../snapshotClient";
import type {
  SectorDeltaRankingBasis,
  SectorDeltaRowView,
  SectorDeltaView,
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
  PgCapabilityRunInput,
  PgCapabilityRunResult,
  SectorDeltaRow,
} from "./types";

const VIEW_SCHEMA_VERSION = 2;
const DEFAULT_MAX_ROWS = 10;
const MAX_ROWS_CAP = 20;
const NO_MEANINGFUL_DELTA_WARNING =
  "No meaningful week-over-week sector delta was found in the latest weekly view.";

type SectorDeltaDirectionFilter =
  | "all"
  | "improved"
  | "deteriorated"
  | "momentum_improved"
  | "momentum_deteriorated";

export type SectorDeltaOptions = {
  queryRunner?: (
    replacements: Record<string, unknown>,
  ) => Promise<SectorDeltaRow[]>;
  maxRows?: number;
  now?: Date;
};

/**
 * Discriminator for `week_over_week_sector_delta`. Both `rankingBasis`
 * and `directionFilter` shape the SQL output, so we hash them together
 * into `criteria_hash` — a single string column can't carry both.
 */
export function sectorDeltaDiscriminators(input: PgCapabilityRunInput): {
  criteriaHash: string;
} {
  return {
    criteriaHash: hashCapabilityParams({
      rankingBasis: inferRankingBasis(input.message),
      directionFilter: inferDirectionFilter(input.message),
    }),
  };
}

export async function buildSectorDeltaView(
  input: PgCapabilityRunInput,
  options: SectorDeltaOptions = {},
): Promise<PgCapabilityRunResult> {
  const rankingBasis = inferRankingBasis(input.message);
  const directionFilter = inferDirectionFilter(input.message);
  const maxRows = clampMaxRows(options.maxRows ?? DEFAULT_MAX_ROWS);

  if (!options.queryRunner && !isExternalPgConfigured()) {
    return {
      views: {
        sectorDeltaView: unavailableView(rankingBasis, [
          "External PG warehouse is not configured for sector week-over-week delta queries.",
        ]),
      },
      warnings: [],
    };
  }

  try {
    const rows = await (options.queryRunner ?? defaultQueryRunner)({
      MAX_ROWS: maxRows,
      RANK_BY: rankingBasis,
      DIRECTION_FILTER: directionFilter,
    });
    const draft = rowsToView(rows, rankingBasis, options.now);
    if (draft.state === "unavailable" || !draft.rows.length) {
      return { views: { sectorDeltaView: draft }, warnings: [] };
    }
    const fanout = await fanOutSectorResearchObjects(input, draft);
    return {
      views: { sectorDeltaView: fanout.view },
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
    const message = "Sector week-over-week delta query failed.";
    logger.warn("Ask Grahamy PG capability failed", {
      capability: "week_over_week_sector_delta",
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      views: {
        sectorDeltaView: unavailableView(rankingBasis, [message]),
      },
      warnings: [message],
    };
  }
}

function defaultQueryRunner(
  replacements: Record<string, unknown>,
): Promise<SectorDeltaRow[]> {
  return runPgCapabilityQuery<SectorDeltaRow>(
    "query_sector_delta",
    replacements,
  );
}

function rowsToView(
  rows: SectorDeltaRow[],
  rankingBasis: SectorDeltaRankingBasis,
  now?: Date,
): SectorDeltaView {
  if (!rows.length) {
    return unavailableView(rankingBasis, [
      "Current or prior weekly sector baseline is missing, so week-over-week deltas are unavailable.",
    ]);
  }

  const first = rows[0];
  const currentAsOfDate = dateStringValue(first.current_as_of_date);
  const priorAsOfDate = dateStringValue(first.prior_as_of_date);
  if (!currentAsOfDate || !priorAsOfDate) {
    return unavailableView(rankingBasis, [
      "Current or prior weekly sector baseline is missing, so week-over-week deltas are unavailable.",
    ]);
  }

  const publicRows = rows
    .filter((row) => boolValue(row.include_in_public))
    .map((row) => rowToPublicRow(row, currentAsOfDate))
    .filter((row): row is SectorDeltaRowView => !!row);

  const freshnessAssessment = buildFreshness(first, currentAsOfDate, now);
  const freshness = freshnessAssessment.publicFreshness;
  if (freshnessAssessment.decision === "unavailable") {
    return unavailableView(
      rankingBasis,
      [freshness.warning ?? "Sector weekly delta data is stale."],
      freshness,
      currentAsOfDate,
      priorAsOfDate,
    );
  }

  const warnings: string[] = [];
  if (!publicRows.length) {
    warnings.push(NO_MEANINGFUL_DELTA_WARNING);
  }
  if (freshness.state === "stale") {
    warnings.push(
      freshness.warning ??
        "This sector delta view uses stale data and should be treated as a snapshot.",
    );
  } else if (freshness.state === "unknown" && freshness.warning) {
    warnings.push(freshness.warning);
  }
  const researchObjectKeys = Array.from(
    new Set(publicRows.map((row) => row.researchObjectKey).filter(Boolean)),
  );

  return {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state: "complete",
    source: "pg_sector_weekly_history",
    period: "week_over_week",
    currentAsOfDate,
    priorAsOfDate,
    rankingBasis,
    rows: publicRows,
    researchObjectKeys,
    freshness,
    warnings,
  };
}

async function fanOutSectorResearchObjects(
  input: PgCapabilityRunInput,
  draft: SectorDeltaView,
): Promise<{
  view: SectorDeltaView;
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
    ...(input.asOfDate ? { asOfDate: input.asOfDate } : {}),
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

function rowToPublicRow(
  row: SectorDeltaRow,
  asOfDate: string | undefined,
): SectorDeltaRowView | null {
  const sector = stringValue(row.sector);
  const rank = integerValue(row.rank);
  const direction = directionValue(row.direction);
  if (!sector || rank == null) return null;

  const publicRow = compactObject({
    sector,
    rank,
    currentConvictionScorePct: roundNumber(row.current_conviction_score_pct, 1),
    priorConvictionScorePct: roundNumber(row.prior_conviction_score_pct, 1),
    convictionDeltaPct: roundNumber(row.conviction_delta_pct, 1),
    currentConvictionBucket: stringValue(row.current_conviction_bucket),
    priorConvictionBucket: stringValue(row.prior_conviction_bucket),
    currentMomentumBucket: stringValue(row.current_momentum_bucket),
    priorMomentumBucket: stringValue(row.prior_momentum_bucket),
    momentumDeltaPct: roundNumber(row.momentum_delta_pct, 1),
    direction,
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
  row: Omit<SectorDeltaRowView, "interpretationBullets" | "researchObjectKey">,
): string[] {
  const bullets: string[] = [];
  if (row.convictionDeltaPct != null) {
    if (row.convictionDeltaPct > 0) {
      bullets.push(`Weekly conviction proxy improved by ${row.convictionDeltaPct} points.`);
    } else if (row.convictionDeltaPct < 0) {
      bullets.push(`Weekly conviction proxy deteriorated by ${Math.abs(row.convictionDeltaPct)} points.`);
    }
  }
  if (row.momentumDeltaPct != null) {
    if (row.momentumDeltaPct > 0) {
      bullets.push(`Weekly price momentum improved by ${row.momentumDeltaPct} points.`);
    } else if (row.momentumDeltaPct < 0) {
      bullets.push(`Weekly price momentum deteriorated by ${Math.abs(row.momentumDeltaPct)} points.`);
    }
  }
  if (row.currentConvictionBucket && row.priorConvictionBucket) {
    bullets.push(
      `Conviction bucket moved from ${row.priorConvictionBucket} to ${row.currentConvictionBucket}.`,
    );
  }
  if (row.currentMomentumBucket && row.priorMomentumBucket) {
    bullets.push(
      `Momentum bucket moved from ${row.priorMomentumBucket} to ${row.currentMomentumBucket}.`,
    );
  }
  return bullets.slice(0, 5);
}

function buildFreshness(
  row: SectorDeltaRow,
  currentAsOfDate: string | undefined,
  now?: Date,
): ReturnType<typeof assessCapabilityFreshness> {
  return assessCapabilityFreshness({
    capability: "week_over_week_sector_delta",
    dataThrough: currentAsOfDate,
    now,
    maxTradingDayLag: 5,
    hardTradingDayLag: 10,
    sources: [
      {
        sourceId: "sector_weekly_history",
        tableOrView: "md_research_sector_monday_hist",
        required: true,
        dataThrough: currentAsOfDate,
        lastSuccessAt: dateTimeStringValue(row.weekly_completed_at),
        refreshState: stringValue(row.weekly_freshness_state),
      },
    ],
  });
}

function unavailableView(
  rankingBasis: SectorDeltaRankingBasis,
  warnings: string[],
  freshness: CapabilityFreshness = { state: "unknown" },
  currentAsOfDate?: string,
  priorAsOfDate?: string,
): SectorDeltaView {
  return {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state: "unavailable",
    source: "pg_sector_weekly_history",
    period: "week_over_week",
    currentAsOfDate,
    priorAsOfDate,
    rankingBasis,
    rows: [],
    researchObjectKeys: [],
    freshness,
    warnings,
  };
}

function inferRankingBasis(message: string): SectorDeltaRankingBasis {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("deteriorat") ||
    normalized.includes("lost") ||
    normalized.includes("declin") ||
    normalized.includes("worse") ||
    normalized.includes("weaken")
  ) {
    return "deterioration";
  }
  if (
    normalized.includes("conviction") ||
    normalized.includes("gained")
  ) {
    return "conviction_delta";
  }
  if (normalized.includes("momentum")) {
    return "momentum_delta";
  }
  return "overall_change";
}

function inferDirectionFilter(message: string): SectorDeltaDirectionFilter {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("momentum") &&
    (
      normalized.includes("lost") ||
      normalized.includes("deteriorat") ||
      normalized.includes("declin") ||
      normalized.includes("worse") ||
      normalized.includes("weaken")
    )
  ) {
    return "momentum_deteriorated";
  }
  if (
    normalized.includes("momentum") &&
    (
      normalized.includes("improved") ||
      normalized.includes("gained") ||
      normalized.includes("gain") ||
      normalized.includes("stronger")
    )
  ) {
    return "momentum_improved";
  }
  if (
    normalized.includes("deteriorat") ||
    normalized.includes("lost") ||
    normalized.includes("declin") ||
    normalized.includes("worse") ||
    normalized.includes("weaken")
  ) {
    return "deteriorated";
  }
  if (
    normalized.includes("improved") ||
    normalized.includes("gained") ||
    normalized.includes("gain") ||
    normalized.includes("stronger")
  ) {
    return "improved";
  }
  return "all";
}

function directionValue(value: unknown): SectorDeltaRowView["direction"] {
  const parsed = stringValue(value);
  if (parsed === "improved" || parsed === "deteriorated" || parsed === "flat") {
    return parsed;
  }
  return "flat";
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
