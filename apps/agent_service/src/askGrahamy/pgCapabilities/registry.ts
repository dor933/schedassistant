import type { CachedResearchObject, Classification, Intent } from "../types";
import { buildResearchObjectsForAnchors } from "../researchObjectBuilder";
import {
  buildFactorConditionedBacktestView,
  factorConditionedBacktestCacheKeyParams,
} from "./factorConditionedBacktest";
import {
  buildFeatureScreenView,
  featureScreenCacheKeyParams,
} from "./featureScreen";
import {
  buildRegimeHistoricalPlaybookView,
  regimeHistoricalPlaybookCacheKeyParams,
} from "./regimeHistoricalPlaybook";
import {
  buildSectorConvictionLeaderboardView,
  sectorConvictionLeaderboardCacheKeyParams,
} from "./sectorConvictionLeaderboard";
import {
  buildSectorLeadersView,
  sectorLeadersCacheKeyParams,
} from "./sectorLeaders";
import {
  buildIndustryLeadersView,
  industryLeadersCacheKeyParams,
} from "./industryLeaders";
import {
  buildSectorDeltaView,
  sectorDeltaCacheKeyParams,
} from "./sectorDelta";
import {
  buildSectorDivergenceView,
  sectorDivergenceCacheKeyParams,
} from "./sectorDivergence";
import {
  buildStockIdeaDiscoveryView,
  stockIdeaDiscoveryCacheKeyParams,
} from "./stockIdeaDiscovery";
import type {
  CachedCapabilityView,
  CapabilityCacheKeyParams,
  PgCapabilityExecuteResult,
  PgCapabilityRegistryEntry,
  PgCapabilityRunInput,
  PgCapabilityRunResult,
  PgCapabilityViews,
} from "./types";

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
    cacheKeyParams: sectorConvictionLeaderboardCacheKeyParams,
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
    cacheKeyParams: sectorDivergenceCacheKeyParams,
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
    cacheKeyParams: sectorDeltaCacheKeyParams,
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
    cacheKeyParams: stockIdeaDiscoveryCacheKeyParams,
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
    cacheKeyParams: sectorLeadersCacheKeyParams,
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
    cacheKeyParams: industryLeadersCacheKeyParams,
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
    cacheKeyParams: featureScreenCacheKeyParams,
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
    cacheKeyParams: factorConditionedBacktestCacheKeyParams,
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
    cacheKeyParams: regimeHistoricalPlaybookCacheKeyParams,
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
 * Cache-aware orchestrator. Mirror of the round-trip used by the v6 research-
 * object path:
 *
 *   - The upstream caller (StocksScanner) reads any rows it has cached for
 *     the classified intent + as_of_date and passes them as `priors`.
 *   - On hit (matching `cache_key` and `viewSchemaVersion`) we skip the SQL
 *     and reuse the stored view.
 *   - On miss we run the capability, attach the freshly built view to
 *     `viewsUpdated`, and return it for the caller to upsert.
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

  const asOfDate = input.snapshots?.freshness?.dataThrough;
  const cacheKey = asOfDate
    ? buildCapabilityCacheKey(entry.name, entry.cacheKeyParams(input), asOfDate)
    : undefined;

  if (cacheKey) {
    const prior = priors.find((p) => p.cacheKey === cacheKey);
    if (prior) {
      const priorViewVersion = (prior.view as { viewSchemaVersion?: number })
        .viewSchemaVersion;
      const liveViewVersion = currentViewSchemaVersion(entry.viewSlot);
      if (
        priorViewVersion === prior.viewSchemaVersion &&
        (liveViewVersion === undefined || liveViewVersion === priorViewVersion)
      ) {
        // Cache hit on the capability view — we still need to (re)resolve the
        // attached research objects so the agent prompt has the deep payload.
        // priorResearchObjects acts as the cache for that fan-out, so this
        // typically resolves entirely from cache.
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
    }
  }

  const result = await runner(input);
  const view = result.views[entry.viewSlot];
  let viewsUpdated: CachedCapabilityView[] = [];

  if (cacheKey && view && asOfDate) {
    const anchors = entry.cacheAnchors ? entry.cacheAnchors(input) : {};
    viewsUpdated = [
      {
        cacheKey,
        capabilityName: entry.name,
        viewSchemaVersion: (view as { viewSchemaVersion: number }).viewSchemaVersion,
        asOfDate,
        priorAsOfDate: extractPriorAsOfDate(view),
        anchorSymbol: anchors.anchorSymbol,
        anchorSector: anchors.anchorSector,
        anchorIndustry: anchors.anchorIndustry,
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

/**
 * Build a deterministic, human-readable cache key.
 *
 *   `CAP:{capability}:{as_of}` — when no params
 *   `CAP:{capability}:{as_of}:{k1=v1|k2=v2}` (params sorted by key)
 *
 * Sorting keeps the key stable across invocations even if the param object's
 * declaration order changes.
 */
export function buildCapabilityCacheKey(
  name: string,
  params: CapabilityCacheKeyParams,
  asOfDate: string,
): string {
  const orderedKeys = Object.keys(params).sort();
  if (orderedKeys.length === 0) return `CAP:${name}:${asOfDate}`;
  const tail = orderedKeys
    .map((key) => `${key}=${stringifyParam(params[key])}`)
    .join("|");
  return `CAP:${name}:${asOfDate}:${tail}`;
}

function stringifyParam(value: string | number | boolean): string {
  return String(value);
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
