import { logger } from "../../logger";
import type { CachedResearchObject, Classification, Intent } from "../types";
import { buildResearchObjectsForAnchors } from "../research/researchObjectBuilder";
import {
  buildFactorConditionedBacktestView,
  factorConditionedBacktestDiscriminators,
} from "./factorConditionedBacktest";
import {
  buildFeatureScreenView,
  featureScreenDiscriminators,
} from "./featureScreen";
import {
  buildRegimeHistoricalPlaybookView,
  regimeHistoricalPlaybookDiscriminators,
} from "./regimeHistoricalPlaybook";
import {
  buildSectorConvictionLeaderboardView,
  sectorConvictionLeaderboardDiscriminators,
} from "./sectorConvictionLeaderboard";
import {
  buildSectorLeadersView,
  sectorLeadersDiscriminators,
} from "./sectorLeaders";
import {
  buildIndustryLeadersView,
  industryLeadersDiscriminators,
} from "./industryLeaders";
import {
  buildSectorDeltaView,
  sectorDeltaDiscriminators,
} from "./sectorDelta";
import {
  buildSectorDivergenceView,
  sectorDivergenceDiscriminators,
} from "./sectorDivergence";
import {
  buildStockIdeaDiscoveryView,
  stockIdeaDiscoveryDiscriminators,
} from "./stockIdeaDiscovery";
import type {
  CachedCapabilityView,
  CapabilityDiscriminators,
  PgCapabilityExecuteResult,
  PgCapabilityRegistryEntry,
  PgCapabilityRunInput,
  PgCapabilityRunResult,
  PgCapabilityViews,
} from "./types";
export { hashCapabilityParams } from "./discriminatorHash";

export const PG_CAPABILITY_REGISTRY: PgCapabilityRegistryEntry[] = [
  {
    name: "sector_conviction_leaderboard",
    intent: "sector_conviction_leaderboard",
    requiredParams: [],
    queryName: "query_sector_conviction_leaderboard",
    source: "pg_sector_peer_daily",
    freshnessSources: [
      "md_research_sector_peer_daily",
      "md_research_sector_regime_fwd_agg",
    ],
    fallback: "unavailable_empty_rows",
    sanitizer: "public_safe_capability_view",
    run: buildSectorConvictionLeaderboardView,
    viewSlot: "sectorLeaderboardView",
    discriminators: sectorConvictionLeaderboardDiscriminators,
  },
  {
    name: "sector_momentum_vs_conviction_divergence",
    intent: "sector_momentum_vs_conviction_divergence",
    requiredParams: [],
    queryName: "query_sector_divergence",
    source: "pg_sector_peer_daily",
    freshnessSources: [
      "md_research_sector_peer_daily",
      "md_research_sector_regime_fwd_agg",
    ],
    fallback: "unavailable_empty_rows",
    sanitizer: "public_safe_capability_view",
    run: buildSectorDivergenceView,
    viewSlot: "sectorDivergenceView",
    discriminators: sectorDivergenceDiscriminators,
  },
  {
    name: "week_over_week_sector_delta",
    intent: "week_over_week_sector_delta",
    requiredParams: [],
    queryName: "query_sector_delta",
    source: "pg_sector_weekly_history",
    freshnessSources: ["md_research_sector_monday_hist"],
    fallback: "unavailable_empty_rows",
    sanitizer: "public_safe_capability_view",
    run: buildSectorDeltaView,
    viewSlot: "sectorDeltaView",
    discriminators: sectorDeltaDiscriminators,
  },
  {
    name: "stock_idea_discovery",
    intent: "stock_idea_discovery",
    requiredParams: [],
    queryName: "query_stock_idea_discovery",
    source: "pg_features_daily",
    freshnessSources: [
      "md_features_daily",
      "md_research_sector_peer_daily",
      "md_forward_returns",
    ],
    fallback: "unavailable_empty_rows",
    sanitizer: "public_safe_capability_view",
    run: buildStockIdeaDiscoveryView,
    viewSlot: "stockIdeaView",
    discriminators: stockIdeaDiscoveryDiscriminators,
  },
  {
    name: "sector_leaders",
    intent: "sector_leaders",
    requiredParams: ["sectors[0]"],
    queryName: "query_sector_leaders",
    source: "pg_features_daily",
    freshnessSources: [
      "md_features_daily",
      "md_research_sector_peer_daily",
      "md_forward_returns",
    ],
    fallback: "unavailable_empty_rows",
    sanitizer: "public_safe_capability_view",
    run: buildSectorLeadersView,
    viewSlot: "stockIdeaView",
    discriminators: sectorLeadersDiscriminators,
    cacheAnchors: (input) => ({
      anchorSector: input.classification.sectors[0],
    }),
  },
  {
    name: "industry_leaders",
    intent: "industry_leaders",
    requiredParams: ["industries[0]"],
    queryName: "query_industry_leaders",
    source: "pg_features_daily",
    // No dedicated industry-level peer MV exists; the SQL falls back to the
    // sector-level peer for the conviction signal. Freshness watches the
    // features table primarily (peer MV is informational here).
    freshnessSources: ["md_features_daily", "md_forward_returns"],
    fallback: "unavailable_empty_rows",
    sanitizer: "public_safe_capability_view",
    run: buildIndustryLeadersView,
    viewSlot: "stockIdeaView",
    discriminators: industryLeadersDiscriminators,
    cacheAnchors: (input) => ({
      anchorIndustry: input.classification.industries[0],
    }),
  },
  {
    name: "feature_screen",
    intent: "feature_screen",
    requiredParams: ["featureCriteria"],
    queryName: "query_feature_screen",
    source: "pg_current_features",
    freshnessSources: [
      "md_features_daily",
      "md_research_sector_peer_daily",
      "md_forward_returns",
    ],
    fallback: "unavailable_empty_rows",
    sanitizer: "public_safe_capability_view",
    run: buildFeatureScreenView,
    viewSlot: "featureScreenView",
    discriminators: featureScreenDiscriminators,
  },
  {
    name: "factor_conditioned_backtest",
    intent: "factor_conditioned_backtest",
    requiredParams: ["factorBacktest.criteria"],
    queryName: "query_factor_conditioned_backtest",
    source: "pg_factor_history",
    freshnessSources: ["sweep_universe"],
    fallback: "unavailable_empty_rows",
    sanitizer: "public_safe_capability_view",
    run: buildFactorConditionedBacktestView,
    viewSlot: "factorBacktestView",
    discriminators: factorConditionedBacktestDiscriminators,
  },
  {
    name: "market_regime_historical_playbook",
    intent: "market_regime_historical_playbook",
    requiredParams: [],
    queryName: "query_regime_historical_playbook",
    source: "pg_regime_history",
    freshnessSources: [
      "md_research_sector_regime_fwd_agg",
      "md_macro_daily_snapshot",
    ],
    fallback: "unavailable_empty_rows",
    sanitizer: "public_safe_capability_view",
    run: buildRegimeHistoricalPlaybookView,
    viewSlot: "regimeHistoricalPlaybookView",
    discriminators: regimeHistoricalPlaybookDiscriminators,
  },
];

/**
 * Intent → registry entry index. One capability per intent today; the lookup
 * stays a Map for O(1) dispatch as new capabilities are added.
 */
const REGISTRY_BY_INTENT = new Map<Intent, PgCapabilityRegistryEntry>();
for (const entry of PG_CAPABILITY_REGISTRY) {
  if (!REGISTRY_BY_INTENT.has(entry.intent)) {
    REGISTRY_BY_INTENT.set(entry.intent, entry);
  }
}

export function capabilityForIntent(
  intent: Intent,
): PgCapabilityRegistryEntry | undefined {
  return REGISTRY_BY_INTENT.get(intent);
}

/**
 * Classification-aware capability dispatcher — currently a thin wrapper over
 * `capabilityForIntent`. Kept as a separate function so future intent-aware
 * dispatch can land here without touching call sites.
 */
export function capabilityForClassification(
  classification: Classification,
): PgCapabilityRegistryEntry | undefined {
  return REGISTRY_BY_INTENT.get(classification.intent);
}

/**
 * Stateless capability dispatcher — picks the registry entry matching the
 * classified intent and runs its query. No cache lookup. Kept as the
 * default runner inside `executePgCapabilitiesWithCache`, and as the
 * test seam used by `runAskGrahamyGraph({ pgCapabilityRunner })`.
 */
export async function executePgCapabilities(
  input: PgCapabilityRunInput,
): Promise<PgCapabilityRunResult> {
  const entry = capabilityForClassification(input.classification);
  if (!entry) return { views: {}, warnings: [] };
  return entry.run(input);
}

/**
 * Live-chat capability resolver. It may only use already-hydrated cached
 * capability views supplied by the caller as DB row ids. It never executes
 * capability SQL and never fans out Research Objects. Missing or stale cache
 * rows are hard errors because the nightly landing graph owns those builds.
 */
export async function resolvePgCapabilitiesFromCacheOnly(
  input: PgCapabilityRunInput,
  priors: CachedCapabilityView[] = [],
): Promise<PgCapabilityExecuteResult> {
  const entry = capabilityForClassification(input.classification);
  if (!entry) {
    return {
      views: {},
      warnings: [],
      viewsUpdated: [],
      cacheStats: { hits: 0, misses: 0, writes: 0 },
    };
  }

  const asOfDate =
    input.asOfDate ?? input.snapshots?.freshness?.dataThrough;
  const discriminators = entry.discriminators(input);
  const anchors = entry.cacheAnchors ? entry.cacheAnchors(input) : {};
  const prior = findPriorMatchingDiscriminators(
    priors,
    entry,
    anchors,
    discriminators,
  );
  if (!prior) {
    throw new Error(
      `Cached capability view is required for ${entry.name}; nightly warm graph did not prepare a matching row.`,
    );
  }

  const priorViewVersion = (prior.view as { viewSchemaVersion?: number })
    .viewSchemaVersion;
  const liveViewVersion = currentViewSchemaVersion(entry.viewSlot);
  if (
    priorViewVersion !== prior.viewSchemaVersion ||
    (liveViewVersion !== undefined && liveViewVersion !== priorViewVersion)
  ) {
    throw new Error(
      `Cached capability view for ${entry.name} has incompatible schema version.`,
    );
  }

  logger.info("PG capability cache-only hit", {
    capability: entry.name,
    asOfDate,
    anchors,
    discriminators,
    viewSchemaVersion: priorViewVersion,
  });

  return {
    views: { [entry.viewSlot]: prior.view } as PgCapabilityViews,
    warnings: [],
    viewsUpdated: [],
    cacheStats: { hits: 1, misses: 0, writes: 0 },
  };
}

/**
 * Cache-aware orchestrator. Mirror of the round-trip used by the v6
 * research-object path, but keyed on typed discriminator columns
 * instead of a derived `cache_key` string:
 *
 *   - The upstream caller (StocksScanner) reads any rows it has cached
 *     for this capability (and the relevant first-class anchor) and
 *     forwards them as `priors`. SS does NOT compute the
 *     message-derived discriminator (`rankingBasis` / `criteriaHash`);
 *     it forwards up to ~8 plausible candidates.
 *   - We compute the discriminator here via the capability's own
 *     `discriminators(input)` function and pick the prior whose
 *     `(rankingBasis, criteriaHash)` matches. View schema version must
 *     also match so a builder version bump doesn't serve a stale shape.
 *   - On hit, the cached view goes out and the per-row research objects
 *     are resolved against `priorResearchObjects` (usually cache-hits
 *     all the way down).
 *   - On miss, we run the capability and attach the freshly built view
 *     to `viewsUpdated` carrying the same discriminator columns so SS
 *     can upsert against the composite unique index.
 *
 * `runner` defaults to `executePgCapabilities` and exists primarily as a
 * test seam (matches the existing `pgCapabilityRunner` graph option).
 */
export async function executePgCapabilitiesWithCache(
  input: PgCapabilityRunInput,
  priors: CachedCapabilityView[] = [],
  runner: (input: PgCapabilityRunInput) => Promise<PgCapabilityRunResult> =
    executePgCapabilities,
): Promise<PgCapabilityExecuteResult> {
  const entry = capabilityForClassification(input.classification);
  if (!entry) {
    return {
      views: {},
      warnings: [],
      viewsUpdated: [],
      cacheStats: { hits: 0, misses: 0, writes: 0 },
    };
  }

  // Prefer the explicit PG `as_of_date` supplied by the caller (SS resolves
  // it via `MAX(as_of_date)` and forwards it on every turn). Fall back to
  // the pipeline `daily_brief` snapshot's `dataThrough` only when missing
  // (older callers, freshly-bootstrapped tests).
  const asOfDate =
    input.asOfDate ?? input.snapshots?.freshness?.dataThrough;

  const discriminators = entry.discriminators(input);
  const anchors = entry.cacheAnchors ? entry.cacheAnchors(input) : {};

  const prior = findPriorMatchingDiscriminators(
    priors,
    entry,
    anchors,
    discriminators,
  );
  if (prior) {
    const priorViewVersion = (prior.view as { viewSchemaVersion?: number })
      .viewSchemaVersion;
    const liveViewVersion = currentViewSchemaVersion(entry.viewSlot);
    if (
      priorViewVersion === prior.viewSchemaVersion &&
      (liveViewVersion === undefined || liveViewVersion === priorViewVersion)
    ) {
      logger.info("PG capability cache hit", {
        capability: entry.name,
        asOfDate,
        anchors,
        discriminators,
        viewSchemaVersion: priorViewVersion,
      });
      // Cache hit on the capability view — we still need to (re)resolve
      // the attached research objects so the agent prompt has the deep
      // payload. priorResearchObjects acts as the cache for that
      // fan-out, so this typically resolves entirely from cache.
      const fanout = await fanOutResearchObjectsForCachedView(input, prior.view);
      return {
        views: { [entry.viewSlot]: prior.view } as PgCapabilityViews,
        warnings: fanout.warnings,
        viewsUpdated: [],
        cacheStats: { hits: 1, misses: 0, writes: 0 },
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
    }
    logger.warn("PG capability cache miss — prior matched discriminators but failed schema version check", {
      capability: entry.name,
      asOfDate,
      anchors,
      discriminators,
      priorViewVersion,
      priorColumnVersion: prior.viewSchemaVersion,
      liveViewVersion,
    });
  } else {
    logger.info("PG capability cache miss — no prior matched discriminators", {
      capability: entry.name,
      asOfDate,
      anchors,
      discriminators,
      priorCount: priors.length,
      priorSummaries: priors.slice(0, 4).map((p) => ({
        capabilityName: p.capabilityName,
        anchorSymbol: p.anchorSymbol,
        anchorSector: p.anchorSector,
        anchorIndustry: p.anchorIndustry,
        rankingBasis: p.rankingBasis,
        criteriaHash: p.criteriaHash,
        viewSchemaVersion: p.viewSchemaVersion,
      })),
    });
  }

  const result = await runner(input);
  const view = result.views[entry.viewSlot];
  let viewsUpdated: CachedCapabilityView[] = [];

  if (view && asOfDate) {
    viewsUpdated = [
      {
        capabilityName: entry.name,
        viewSchemaVersion: (view as { viewSchemaVersion: number }).viewSchemaVersion,
        asOfDate,
        ...(extractPriorAsOfDate(view)
          ? { priorAsOfDate: extractPriorAsOfDate(view) }
          : {}),
        ...(anchors.anchorSymbol ? { anchorSymbol: anchors.anchorSymbol } : {}),
        ...(anchors.anchorSector ? { anchorSector: anchors.anchorSector } : {}),
        ...(anchors.anchorIndustry
          ? { anchorIndustry: anchors.anchorIndustry }
          : {}),
        ...(discriminators.rankingBasis
          ? { rankingBasis: discriminators.rankingBasis }
          : {}),
        ...(discriminators.criteriaHash
          ? { criteriaHash: discriminators.criteriaHash }
          : {}),
        view: view as CachedCapabilityView["view"],
        generatedAt: new Date().toISOString(),
      },
    ];
  }

  return {
    ...result,
    viewsUpdated,
    cacheStats: {
      hits: 0,
      misses: 1,
      writes: viewsUpdated.length,
    },
  };
}

/**
 * Find a SS-supplied prior matching this turn's discriminators. SS
 * already narrowed by capability + first-class anchor; we finalise the
 * match by `(rankingBasis, criteriaHash)` (which SS doesn't know about).
 * Returns undefined when no prior matches.
 */
function findPriorMatchingDiscriminators(
  priors: CachedCapabilityView[],
  entry: PgCapabilityRegistryEntry,
  anchors: { anchorSymbol?: string; anchorSector?: string; anchorIndustry?: string },
  discriminators: CapabilityDiscriminators,
): CachedCapabilityView | undefined {
  if (!priors.length) return undefined;
  return priors.find((p) => {
    if (p.capabilityName !== entry.name) return false;
    if (!eqOptionalCi(p.anchorSymbol, anchors.anchorSymbol)) return false;
    if (!eqOptionalCi(p.anchorSector, anchors.anchorSector)) return false;
    if (!eqOptionalCi(p.anchorIndustry, anchors.anchorIndustry)) return false;
    if (normalizeOptional(p.rankingBasis) !== normalizeOptional(discriminators.rankingBasis))
      return false;
    if (normalizeOptional(p.criteriaHash) !== normalizeOptional(discriminators.criteriaHash))
      return false;
    return true;
  });
}

// The SS-side persistence layer stores unused anchors/discriminators as
// empty strings ("") rather than NULL, so priors arrive with "" where the
// live side computes `undefined`. Treat both as "no value" so a genuinely
// matching prior (no anchors, no criteria) doesn't get rejected and force
// a full SQL re-run + per-row RO fan-out.
function normalizeOptional(value: string | undefined | null): string | null {
  if (value === undefined || value === null || value === "") return null;
  return value;
}

function eqOptionalCi(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  const left = normalizeOptional(a);
  const right = normalizeOptional(b);
  if (left === null && right === null) return true;
  if (left === null || right === null) return false;
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Cache-hit path: the persisted capability view already names the research
 * objects it depends on via `researchObjectKeys` (and `regimeResearchObjectKey`
 * for the regime playbook). Resolve those keys back to full research objects
 * — `priorResearchObjects` is the upstream caller's cache, so most calls
 * complete without hitting the database again.
 */
async function fanOutResearchObjectsForCachedView(
  input: PgCapabilityRunInput,
  view: unknown,
): Promise<{
  researchObjects: CachedResearchObject[];
  researchObjectsUpdated: CachedResearchObject[];
  stats: { hits: number; misses: number; writes: number } | undefined;
  warnings: string[];
}> {
  const targets = anchorsFromCachedView(view);
  if (
    !targets.symbols.length &&
    !targets.sectors.length &&
    !targets.regimeRequested
  ) {
    return {
      researchObjects: [],
      researchObjectsUpdated: [],
      stats: undefined,
      warnings: [],
    };
  }
  const builder = input.researchObjectBuilder ?? buildResearchObjectsForAnchors;
  const result = await builder({
    symbols: targets.symbols,
    sectors: targets.sectors,
    regimeRequested: targets.regimeRequested,
    snapshots: input.snapshots,
    toolOutputs: input.toolOutputs,
    priorResearchObjects: input.priorResearchObjects,
    ...(input.asOfDate ? { asOfDate: input.asOfDate } : {}),
  });
  return {
    researchObjects: result.objects,
    researchObjectsUpdated: result.objectsUpdated,
    stats: result.stats,
    warnings: result.warnings,
  };
}

function anchorsFromCachedView(view: unknown): {
  symbols: string[];
  sectors: string[];
  regimeRequested: boolean;
} {
  if (!view || typeof view !== "object") {
    return { symbols: [], sectors: [], regimeRequested: false };
  }
  const record = view as {
    rows?: unknown;
    researchObjectKeys?: unknown;
    regimeResearchObjectKey?: unknown;
    contributingResearchObjectKeys?: unknown;
  };
  const keys = new Set<string>();
  const symbols = new Map<string, string>();
  const sectors = new Map<string, string>();
  for (const list of [record.researchObjectKeys, record.contributingResearchObjectKeys]) {
    if (Array.isArray(list)) {
      for (const k of list) if (typeof k === "string" && k) keys.add(k);
    }
  }
  if (Array.isArray(record.rows)) {
    for (const row of record.rows) {
      if (
        row &&
        typeof row === "object"
      ) {
        const rowRecord = row as {
          researchObjectKey?: unknown;
          symbol?: unknown;
          sector?: unknown;
        };
        if (typeof rowRecord.symbol === "string" && rowRecord.symbol) {
          symbols.set(rowRecord.symbol.toUpperCase(), rowRecord.symbol.toUpperCase());
        }
        if (typeof rowRecord.sector === "string" && rowRecord.sector) {
          sectors.set(rowRecord.sector.toUpperCase(), rowRecord.sector);
        }
        if (typeof rowRecord.researchObjectKey === "string") {
          keys.add(rowRecord.researchObjectKey);
        }
      }
    }
  }
  if (typeof record.regimeResearchObjectKey === "string" && record.regimeResearchObjectKey) {
    keys.add(record.regimeResearchObjectKey);
  }
  let regimeRequested = false;
  for (const key of keys) {
    const [kind, anchor] = key.split(":");
    if (!anchor) continue;
    if (kind === "STOCK") symbols.set(anchor.toUpperCase(), anchor.toUpperCase());
    else if (kind === "SECTOR" && !sectors.has(anchor.toUpperCase())) {
      sectors.set(anchor.toUpperCase(), anchor);
    }
    else if (kind === "REGIME") regimeRequested = true;
  }
  return {
    symbols: [...symbols.values()],
    sectors: [...sectors.values()],
    regimeRequested,
  };
}

function extractPriorAsOfDate(view: unknown): string | undefined {
  if (!view || typeof view !== "object") return undefined;
  const candidate = (view as { priorAsOfDate?: unknown }).priorAsOfDate;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

/**
 * Lightweight indirection so we can refuse cache hits whose schema version
 * disagrees with the build code currently in this process. The capability
 * builders all use a local `VIEW_SCHEMA_VERSION = 1` today; if/when one of
 * them bumps to 2 without updating priors in the upstream DB, hits would
 * silently serve a stale shape. Returning `undefined` here means "no live
 * version known" and falls back to trusting the prior's recorded version.
 *
 * Today every capability is at version 1, so a prior with `viewSchemaVersion
 * === 1` always matches. When we later bump a version we can centralise the
 * map here without touching graph.ts or each capability's call sites.
 */
const CURRENT_VIEW_SCHEMA_VERSION_BY_SLOT: Record<keyof PgCapabilityViews, number> = {
  sectorLeaderboardView: 2,
  sectorDivergenceView: 2,
  sectorDeltaView: 2,
  stockIdeaView: 2,
  featureScreenView: 2,
  factorBacktestView: 2,
  regimeHistoricalPlaybookView: 2,
};

function currentViewSchemaVersion(
  viewSlot: keyof PgCapabilityViews,
): number | undefined {
  return CURRENT_VIEW_SCHEMA_VERSION_BY_SLOT[viewSlot];
}
