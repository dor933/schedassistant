import type {
  Classification,
  ComparisonView,
  EvidenceState,
  PublicFreshnessView,
  SectorDeltaView,
  SectorDivergenceView,
  SectorLeaderboardView,
  SnapshotBundle,
  StockIdeaView,
  ToolOutputs,
} from "../types";

export type PgCapabilityIntent =
  | "sector_conviction_leaderboard"
  | "sector_momentum_vs_conviction_divergence"
  | "week_over_week_sector_delta"
  | "stock_idea_discovery"
  | "comparison";

export type PgCapabilityName =
  | "sector_conviction_leaderboard"
  | "sector_momentum_vs_conviction_divergence"
  | "week_over_week_sector_delta"
  | "stock_idea_discovery"
  | "stock_vs_sector_comparison"
  | "sector_vs_sector_comparison"
  | "symbol_vs_symbol_comparison";

export type PgCapabilityQueryName =
  | "query_sector_conviction_leaderboard"
  | "query_sector_divergence"
  | "query_sector_delta"
  | "query_stock_idea_discovery"
  | "query_stock_vs_sector_comparison"
  | "query_sector_vs_sector_comparison"
  | "query_symbol_vs_symbol_comparison";

export type PgCapabilityRunInput = {
  classification: Classification;
  message: string;
  snapshots: SnapshotBundle;
  toolOutputs: ToolOutputs;
};

export type PgCapabilityViews = {
  sectorLeaderboardView?: SectorLeaderboardView;
  sectorDivergenceView?: SectorDivergenceView;
  sectorDeltaView?: SectorDeltaView;
  stockIdeaView?: StockIdeaView;
  comparisonView?: ComparisonView;
};

export type PgCapabilityRunResult = {
  views: PgCapabilityViews;
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
    | "pg_current_features";
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
  ) => { anchorSymbol?: string; anchorSector?: string };
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
  /** stock_vs_sector_comparison only — the left-side symbol. */
  anchorSymbol?: string;
  /** stock_vs_sector_comparison only — the resolved canonical sector. */
  anchorSector?: string;
  view:
    | import("../types").SectorLeaderboardView
    | import("../types").SectorDivergenceView
    | import("../types").SectorDeltaView
    | import("../types").StockIdeaView
    | import("../types").ComparisonView;
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

export type StockVsSectorComparisonRow = Record<string, unknown> & {
  symbol?: unknown;
  company_name?: unknown;
  stock_sector?: unknown;
  requested_sector?: unknown;
  resolved_sector?: unknown;
  explicit_sector_valid?: unknown;
  comparison_sector_found?: unknown;
  as_of_date?: unknown;
  stock_conviction_score_pct?: unknown;
  stock_conviction_bucket?: unknown;
  stock_valuation_bucket?: unknown;
  stock_momentum_bucket?: unknown;
  stock_quality_bucket?: unknown;
  stock_growth_bucket?: unknown;
  stock_leverage_bucket?: unknown;
  stock_hit_rate_pct?: unknown;
  stock_median_return_pct?: unknown;
  sector_conviction_score_pct?: unknown;
  sector_conviction_bucket?: unknown;
  sector_momentum_bucket?: unknown;
  sector_quality_bucket?: unknown;
  sector_growth_bucket?: unknown;
  sector_leverage_bucket?: unknown;
  sector_hit_rate_pct?: unknown;
  features_freshness_state?: unknown;
  features_completed_at?: unknown;
  peer_freshness_state?: unknown;
  peer_completed_at?: unknown;
  forward_freshness_state?: unknown;
  forward_completed_at?: unknown;
  stock_forward_overlay_available?: unknown;
  sector_forward_overlay_available?: unknown;
};

export type SectorVsSectorComparisonRow = Record<string, unknown> & {
  left_sector?: unknown;
  right_sector?: unknown;
  left_sector_found?: unknown;
  right_sector_found?: unknown;
  as_of_date?: unknown;
  left_conviction_score_pct?: unknown;
  left_conviction_bucket?: unknown;
  left_momentum_bucket?: unknown;
  left_quality_bucket?: unknown;
  left_growth_bucket?: unknown;
  left_leverage_bucket?: unknown;
  left_hit_rate_pct?: unknown;
  right_conviction_score_pct?: unknown;
  right_conviction_bucket?: unknown;
  right_momentum_bucket?: unknown;
  right_quality_bucket?: unknown;
  right_growth_bucket?: unknown;
  right_leverage_bucket?: unknown;
  right_hit_rate_pct?: unknown;
  peer_freshness_state?: unknown;
  peer_completed_at?: unknown;
  forward_freshness_state?: unknown;
  forward_completed_at?: unknown;
  left_forward_overlay_available?: unknown;
  right_forward_overlay_available?: unknown;
};

export type SymbolVsSymbolComparisonRow = Record<string, unknown> & {
  left_requested_symbol?: unknown;
  right_requested_symbol?: unknown;
  left_symbol?: unknown;
  right_symbol?: unknown;
  left_symbol_found?: unknown;
  right_symbol_found?: unknown;
  left_company_name?: unknown;
  right_company_name?: unknown;
  left_sector?: unknown;
  right_sector?: unknown;
  as_of_date?: unknown;
  left_conviction_score_pct?: unknown;
  left_conviction_bucket?: unknown;
  left_valuation_bucket?: unknown;
  left_momentum_bucket?: unknown;
  left_quality_bucket?: unknown;
  left_growth_bucket?: unknown;
  left_leverage_bucket?: unknown;
  left_hit_rate_pct?: unknown;
  left_median_return_pct?: unknown;
  right_conviction_score_pct?: unknown;
  right_conviction_bucket?: unknown;
  right_valuation_bucket?: unknown;
  right_momentum_bucket?: unknown;
  right_quality_bucket?: unknown;
  right_growth_bucket?: unknown;
  right_leverage_bucket?: unknown;
  right_hit_rate_pct?: unknown;
  right_median_return_pct?: unknown;
  features_freshness_state?: unknown;
  features_completed_at?: unknown;
  peer_freshness_state?: unknown;
  peer_completed_at?: unknown;
  forward_freshness_state?: unknown;
  forward_completed_at?: unknown;
  left_forward_overlay_available?: unknown;
  right_forward_overlay_available?: unknown;
};

export type EmptyCapabilityView = {
  viewSchemaVersion: number;
  state: EvidenceState;
  rows: [];
  warnings: string[];
};
