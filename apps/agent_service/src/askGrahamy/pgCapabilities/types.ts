import type {
  CachedResearchObject,
  Classification,
  EvidenceState,
  FactorBacktestCriterion,
  FactorBacktestView,
  FeatureScreenCriterion,
  FeatureScreenView,
  PublicFreshnessView,
  RegimeHistoricalPlaybookView,
  SectorDeltaView,
  SectorDivergenceView,
  SectorLeaderboardView,
  SnapshotBundle,
  StockIdeaView,
  ToolOutputs,
} from "../types";
import type { ResearchObjectBuildResult } from "../researchObjectBuilder";

export type PgCapabilityIntent =
  | "sector_conviction_leaderboard"
  | "sector_momentum_vs_conviction_divergence"
  | "week_over_week_sector_delta"
  | "stock_idea_discovery"
  | "sector_leaders"
  | "industry_leaders"
  | "feature_screen"
  | "factor_conditioned_backtest"
  | "market_regime_historical_playbook";

export type PgCapabilityName =
  | "sector_conviction_leaderboard"
  | "sector_momentum_vs_conviction_divergence"
  | "week_over_week_sector_delta"
  | "stock_idea_discovery"
  | "sector_leaders"
  | "industry_leaders"
  | "feature_screen"
  | "factor_conditioned_backtest"
  | "market_regime_historical_playbook";

export type PgCapabilityQueryName =
  | "query_sector_conviction_leaderboard"
  | "query_sector_divergence"
  | "query_sector_delta"
  | "query_stock_idea_discovery"
  | "query_sector_leaders"
  | "query_industry_leaders"
  | "query_feature_screen"
  | "query_factor_conditioned_backtest"
  | "query_regime_historical_playbook";

export type PgCapabilityRunInput = {
  classification: Classification;
  message: string;
  snapshots: SnapshotBundle;
  toolOutputs: ToolOutputs;
  /**
   * Research objects the upstream caller already had cached for this
   * `as_of_date`. Capabilities forward these to the research-object builder
   * so the deep payload they attach to each row reuses the SAME shared cache
   * the anchored research-object flow uses (single source of truth across
   * discovery and anchored answers).
   */
  priorResearchObjects?: CachedResearchObject[];
  /**
   * Canonical PG `as_of_date` (YYYY-MM-DD) — used as the cache-key date for
   * capability views AND for any child Research Objects the capability fans
   * out via `buildResearchObjectsForAnchors`. Without this, both the
   * capability cache key and child-RO cache keys fall back to the pipeline
   * `daily_brief` snapshot's `dataThrough`, which can lag the actual PG
   * data date and produce silent cache-key mismatches with the SS-side
   * cache (which keys by PG date). Optional for back-compat.
   */
  asOfDate?: string;
  /**
   * Test seam — overrides the default research-object builder. Capabilities
   * fall back to `buildResearchObjectsForAnchors` from `researchObjectBuilder`
   * when this is omitted.
   */
  researchObjectBuilder?: (input: {
    symbols?: string[];
    sectors?: string[];
    industries?: string[];
    regimeRequested?: boolean;
    snapshots: SnapshotBundle;
    toolOutputs?: ToolOutputs;
    priorResearchObjects?: CachedResearchObject[];
    asOfDate?: string;
  }) => Promise<ResearchObjectBuildResult>;
};

export type PgCapabilityViews = {
  sectorLeaderboardView?: SectorLeaderboardView;
  sectorDivergenceView?: SectorDivergenceView;
  sectorDeltaView?: SectorDeltaView;
  stockIdeaView?: StockIdeaView;
  featureScreenView?: FeatureScreenView;
  factorBacktestView?: FactorBacktestView;
  regimeHistoricalPlaybookView?: RegimeHistoricalPlaybookView;
};

export type PgCapabilityRunResult = {
  views: PgCapabilityViews;
  /** All research objects this capability resolved (from cache or freshly
   * built) for the discovered anchors. Includes both hits and misses. */
  researchObjects?: CachedResearchObject[];
  /** Subset of `researchObjects` that need persistence by the upstream caller —
   * cache misses only. Empty when every anchor was a cache hit. */
  researchObjectsUpdated?: CachedResearchObject[];
  /** Cache stats for the research-object fan-out (mirrors the standard-path
   * researchObjectCacheStats shape on AskGrahamyState). */
  researchObjectCacheStats?: { hits: number; misses: number; writes: number };
  warnings: string[];
};

/**
 * Subset of capability-input fields that, together with `as_of_date`, uniquely
 * identify a capability view. Each capability supplies its own extractor
 * (e.g., leaderboard's `rankingBasis`, comparison's `(leftSymbol, rightSector)`)
 * and the orchestrator stringifies the result into `cache_key`.
 */
export type CapabilityCacheKeyParams = Record<string, string | number | boolean>;

export type PgCapabilityRegistryEntry = {
  name: PgCapabilityName;
  intent: PgCapabilityIntent;
  requiredParams: string[];
  queryName: PgCapabilityQueryName;
  source:
    | "pg_sector_peer_daily"
    | "pg_sector_regime_forward_agg"
    | "pg_sector_analog_bucket"
    | "pg_sector_weekly_history"
    | "pg_features_daily"
    | "pg_current_features"
    | "pg_factor_history"
    | "pg_regime_history";
  freshnessSources: string[];
  fallback: "unavailable_empty_rows";
  sanitizer: "public_safe_capability_view";
  run: (input: PgCapabilityRunInput) => Promise<PgCapabilityRunResult>;
  /** Which slot of `PgCapabilityViews` this capability fills. */
  viewSlot: keyof PgCapabilityViews;
  /** Subset of input fields baked into the cache key. */
  cacheKeyParams: (input: PgCapabilityRunInput) => CapabilityCacheKeyParams;
  /**
   * Anchor extractors for the cached row. Sector/leaderboard/idea capabilities
   * are org-wide singletons per day (no anchors); comparison fills these.
   */
  cacheAnchors?: (
    input: PgCapabilityRunInput,
  ) => { anchorSymbol?: string; anchorSector?: string; anchorIndustry?: string };
};

/**
 * A capability view persisted by the upstream caller (StocksScanner) and
 * passed back on the next request as `priorCapabilityViews`. Mirrors the
 * `CachedResearchObject` round-trip used by the v6 path.
 */
export type CachedCapabilityView = {
  cacheKey: string;
  capabilityName: PgCapabilityName;
  viewSchemaVersion: number;
  /** Snapshot publish date used for keying — `snapshots.freshness.dataThrough`. */
  asOfDate: string;
  /** sector_delta only — the SQL's `prior_as_of_date` for the same row. */
  priorAsOfDate?: string;
  /** Reserved for capabilities anchored to a single symbol; currently unused. */
  anchorSymbol?: string;
  /** Reserved for capabilities anchored to a single sector; currently unused. */
  anchorSector?: string;
  /** Reserved for capabilities anchored to a single industry (industry_leaders). */
  anchorIndustry?: string;
  view:
    | import("../types").SectorLeaderboardView
    | import("../types").SectorDivergenceView
    | import("../types").SectorDeltaView
    | import("../types").StockIdeaView
    | import("../types").FeatureScreenView
    | import("../types").FactorBacktestView
    | import("../types").RegimeHistoricalPlaybookView;
  generatedAt: string;
};

/**
 * Output of the cache-aware orchestrator. Adds `viewsUpdated` and
 * `cacheStats` on top of the per-capability `PgCapabilityRunResult` so
 * `graph.ts` can surface them on `state` and `meta` symmetrically with
 * `researchObjectsUpdated` / `researchObjectCache`.
 */
export type PgCapabilityExecuteResult = {
  views: PgCapabilityViews;
  warnings: string[];
  viewsUpdated: CachedCapabilityView[];
  cacheStats: { hits: number; misses: number; writes: number };
  /** Research objects discovery resolved/built while running the capability —
   * forwarded so the graph node can merge them into `state.researchObjects`
   * and the agent prompt renders them via the existing per-RO loop. */
  researchObjects?: CachedResearchObject[];
  researchObjectsUpdated?: CachedResearchObject[];
  researchObjectCacheStats?: { hits: number; misses: number; writes: number };
};

export type CapabilityFreshness = PublicFreshnessView;

export type SectorConvictionLeaderboardRow = Record<string, unknown> & {
  sector?: unknown;
  rank?: unknown;
  conviction_score_pct?: unknown;
  conviction_bucket?: unknown;
  evidence_strength?: unknown;
  hit_rate_pct?: unknown;
  momentum_bucket?: unknown;
  price_momentum_separation?: unknown;
  defensive_cyclical_label?: unknown;
  as_of_date?: unknown;
  current_market_regime?: unknown;
  peer_freshness_state?: unknown;
  peer_completed_at?: unknown;
  forward_freshness_state?: unknown;
  forward_completed_at?: unknown;
  overlay_available?: unknown;
  evaluated_sector_count?: unknown;
  clear_divergence_count?: unknown;
};

export type SectorDivergenceRow = Record<string, unknown> & {
  sector?: unknown;
  rank?: unknown;
  conviction_score_pct?: unknown;
  conviction_bucket?: unknown;
  momentum_score_pct?: unknown;
  momentum_bucket?: unknown;
  divergence_type?: unknown;
  evidence_strength?: unknown;
  hit_rate_pct?: unknown;
  median_forward_return_pct?: unknown;
  as_of_date?: unknown;
  peer_freshness_state?: unknown;
  peer_completed_at?: unknown;
  forward_freshness_state?: unknown;
  forward_completed_at?: unknown;
  overlay_available?: unknown;
};

export type SectorDeltaRow = Record<string, unknown> & {
  sector?: unknown;
  rank?: unknown;
  current_conviction_score_pct?: unknown;
  prior_conviction_score_pct?: unknown;
  conviction_delta_pct?: unknown;
  current_conviction_bucket?: unknown;
  prior_conviction_bucket?: unknown;
  current_momentum_score_pct?: unknown;
  prior_momentum_score_pct?: unknown;
  momentum_delta_pct?: unknown;
  current_momentum_bucket?: unknown;
  prior_momentum_bucket?: unknown;
  direction?: unknown;
  include_in_public?: unknown;
  current_as_of_date?: unknown;
  prior_as_of_date?: unknown;
  weekly_freshness_state?: unknown;
  weekly_completed_at?: unknown;
  evaluated_sector_count?: unknown;
  meaningful_delta_count?: unknown;
};

export type StockIdeaDiscoveryRow = Record<string, unknown> & {
  symbol?: unknown;
  company_name?: unknown;
  sector?: unknown;
  rank?: unknown;
  conviction_score_pct?: unknown;
  conviction_bucket?: unknown;
  evidence_strength?: unknown;
  hit_rate_pct?: unknown;
  median_return_pct?: unknown;
  p25_return_pct?: unknown;
  p75_return_pct?: unknown;
  momentum_bucket?: unknown;
  quality_bucket?: unknown;
  valuation_bucket?: unknown;
  path_risk_bucket?: unknown;
  as_of_date?: unknown;
  features_freshness_state?: unknown;
  features_completed_at?: unknown;
  peer_freshness_state?: unknown;
  peer_completed_at?: unknown;
  forward_overlay_available?: unknown;
};

export type FeatureScreenRow = Record<string, unknown> & {
  symbol?: unknown;
  company_name?: unknown;
  sector?: unknown;
  rank?: unknown;
  valuation_bucket?: unknown;
  quality_bucket?: unknown;
  momentum_bucket?: unknown;
  growth_bucket?: unknown;
  leverage_bucket?: unknown;
  risk_bucket?: unknown;
  conviction_bucket?: unknown;
  hit_rate_pct?: unknown;
  median_return_pct?: unknown;
  as_of_date?: unknown;
  current_row_count?: unknown;
  matched_row_count?: unknown;
  features_freshness_state?: unknown;
  features_completed_at?: unknown;
  peer_freshness_state?: unknown;
  peer_completed_at?: unknown;
  forward_overlay_available?: unknown;
  criteria?: FeatureScreenCriterion[];
};

export type FactorBacktestRow = Record<string, unknown> & {
  as_of_date?: unknown;
  horizon?: unknown;
  sample_size?: unknown;
  hit_rate_pct?: unknown;
  median_return_pct?: unknown;
  p25_return_pct?: unknown;
  p75_return_pct?: unknown;
  matched_row_count?: unknown;
  source_row_count?: unknown;
  capped_sample?: unknown;
  contributing_symbols?: unknown;
  criteria?: FactorBacktestCriterion[];
};

export type RegimeHistoricalPlaybookRow = Record<string, unknown> & {
  regime?: unknown;
  as_of_date?: unknown;
  sector?: unknown;
  rank?: unknown;
  role?: unknown;
  include_in_public?: unknown;
  sample_size?: unknown;
  hit_rate_pct?: unknown;
  median_forward_return_pct?: unknown;
  evidence_strength?: unknown;
  vix_risk_bucket?: unknown;
  breadth_risk_bucket?: unknown;
  dispersion_risk_bucket?: unknown;
  trend_risk_bucket?: unknown;
  risk_context_available?: unknown;
  regime_freshness_state?: unknown;
  regime_completed_at?: unknown;
  macro_freshness_state?: unknown;
  macro_completed_at?: unknown;
  evaluated_sector_count?: unknown;
  meaningful_sector_count?: unknown;
};

export type EmptyCapabilityView = {
  viewSchemaVersion: number;
  state: EvidenceState;
  rows: [];
  warnings: string[];
};
