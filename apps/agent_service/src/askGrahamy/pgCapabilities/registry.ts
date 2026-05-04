import type { Classification, Intent } from "../types";
import {
  buildSectorConvictionLeaderboardView,
  sectorConvictionLeaderboardCacheKeyParams,
} from "./sectorConvictionLeaderboard";
import {
  buildSectorDeltaView,
  sectorDeltaCacheKeyParams,
} from "./sectorDelta";
import {
  buildSectorDivergenceView,
  sectorDivergenceCacheKeyParams,
} from "./sectorDivergence";
import {
  buildSectorVsSectorComparisonView,
  sectorVsSectorComparisonAnchors,
  sectorVsSectorComparisonCacheKeyParams,
} from "./sectorVsSectorComparison";
import {
  buildStockIdeaDiscoveryView,
  stockIdeaDiscoveryCacheKeyParams,
} from "./stockIdeaDiscovery";
import {
  buildStockVsSectorComparisonView,
  stockVsSectorComparisonAnchors,
  stockVsSectorComparisonCacheKeyParams,
} from "./stockVsSectorComparison";
import {
  buildSymbolVsSymbolComparisonView,
  symbolVsSymbolComparisonAnchors,
  symbolVsSymbolComparisonCacheKeyParams,
} from "./symbolVsSymbolComparison";
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
    name: "stock_vs_sector_comparison",
    intent: "comparison",
    requiredParams: ["comparison.left.symbol"],
    queryName: "query_stock_vs_sector_comparison",
    source: "pg_current_features",
    freshnessSources: [
      "md_features_daily",
      "md_research_sector_peer_daily",
      "md_forward_returns",
    ],
    fallback: "unavailable_empty_rows",
    sanitizer: "public_safe_capability_view",
    run: buildStockVsSectorComparisonView,
    viewSlot: "comparisonView",
    cacheKeyParams: stockVsSectorComparisonCacheKeyParams,
    cacheAnchors: stockVsSectorComparisonAnchors,
  },
  {
    name: "sector_vs_sector_comparison",
    intent: "comparison",
    requiredParams: ["comparison.left.sector", "comparison.right.sector"],
    queryName: "query_sector_vs_sector_comparison",
    source: "pg_sector_peer_daily",
    freshnessSources: [
      "md_research_sector_peer_daily",
      "md_research_sector_regime_fwd_agg",
    ],
    fallback: "unavailable_empty_rows",
    sanitizer: "public_safe_capability_view",
    run: buildSectorVsSectorComparisonView,
    viewSlot: "comparisonView",
    cacheKeyParams: sectorVsSectorComparisonCacheKeyParams,
    cacheAnchors: sectorVsSectorComparisonAnchors,
  },
  {
    name: "symbol_vs_symbol_comparison",
    intent: "comparison",
    requiredParams: ["comparison.left.symbol", "comparison.right.symbol"],
    queryName: "query_symbol_vs_symbol_comparison",
    source: "pg_current_features",
    freshnessSources: [
      "md_features_daily",
      "md_research_sector_peer_daily",
      "md_forward_returns",
    ],
    fallback: "unavailable_empty_rows",
    sanitizer: "public_safe_capability_view",
    run: buildSymbolVsSymbolComparisonView,
    viewSlot: "comparisonView",
    cacheKeyParams: symbolVsSymbolComparisonCacheKeyParams,
    cacheAnchors: symbolVsSymbolComparisonAnchors,
  },
];

/**
 * Intent → registry entry index. `comparison` has multiple implementation
 * entries; this map stores the stock_vs_sector default for legacy callers.
 * Classification-aware dispatch below chooses the concrete comparison type.
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
 * Classification-aware capability dispatcher. For most intents it behaves
 * identically to `capabilityForIntent`; for `intent="comparison"` it reads
 * `classification.comparison.comparisonType` and routes to the concrete
 * comparison capability. Missing or future comparison types fall back to the
 * stock_vs_sector default so misclassified inputs surface as unavailable
 * instead of crashing.
 */
export function capabilityForClassification(
  classification: Classification,
): PgCapabilityRegistryEntry | undefined {
  if (classification.intent !== "comparison") {
    return REGISTRY_BY_INTENT.get(classification.intent);
  }
  const comparisonType = classification.comparison?.comparisonType;
  const targetName: PgCapabilityRegistryEntry["name"] | undefined =
    comparisonType === "stock_vs_sector"
      ? "stock_vs_sector_comparison"
      : comparisonType === "sector_vs_sector"
        ? "sector_vs_sector_comparison"
        : comparisonType === "symbol_vs_symbol"
          ? "symbol_vs_symbol_comparison"
      : undefined;
  if (!targetName) return REGISTRY_BY_INTENT.get("comparison");
  return PG_CAPABILITY_REGISTRY.find((entry) => entry.name === targetName);
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
        return {
          views: { [entry.viewSlot]: prior.view } as PgCapabilityViews,
          warnings: [],
          viewsUpdated: [],
          cacheStats: { hits: 1, misses: 0, writes: 0 },
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
function currentViewSchemaVersion(
  _viewSlot: keyof PgCapabilityViews,
): number | undefined {
  return undefined;
}
