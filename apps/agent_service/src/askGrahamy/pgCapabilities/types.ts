import type {
  Classification,
  EvidenceState,
  PublicFreshnessView,
  SectorLeaderboardView,
  SnapshotBundle,
  StockIdeaView,
  ToolOutputs,
} from "../types";

export type PgCapabilityIntent =
  | "sector_conviction_leaderboard"
  | "stock_idea_discovery";

export type PgCapabilityName =
  | "sector_conviction_leaderboard"
  | "stock_idea_discovery";

export type PgCapabilityQueryName =
  | "query_sector_conviction_leaderboard"
  | "query_stock_idea_discovery";

export type PgCapabilityRunInput = {
  classification: Classification;
  message: string;
  snapshots: SnapshotBundle;
  toolOutputs: ToolOutputs;
};

export type PgCapabilityViews = {
  sectorLeaderboardView?: SectorLeaderboardView;
  stockIdeaView?: StockIdeaView;
};

export type PgCapabilityRunResult = {
  views: PgCapabilityViews;
  warnings: string[];
};

export type PgCapabilityRegistryEntry = {
  name: PgCapabilityName;
  intent: PgCapabilityIntent;
  requiredParams: string[];
  queryName: PgCapabilityQueryName;
  source:
    | "pg_sector_peer_daily"
    | "pg_sector_regime_forward_agg"
    | "pg_sector_analog_bucket"
    | "pg_features_daily";
  freshnessSources: string[];
  fallback: "unavailable_empty_rows";
  sanitizer: "public_safe_capability_view";
  run: (input: PgCapabilityRunInput) => Promise<PgCapabilityRunResult>;
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

export type EmptyCapabilityView = {
  viewSchemaVersion: number;
  state: EvidenceState;
  rows: [];
  warnings: string[];
};
