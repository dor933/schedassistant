import type {
  Classification,
  EvidenceState,
  FreshnessMetadata,
  SectorLeaderboardView,
  SnapshotBundle,
  ToolOutputs,
} from "../types";

export type PgCapabilityIntent = "sector_conviction_leaderboard";

export type PgCapabilityName = "sector_conviction_leaderboard";

export type PgCapabilityQueryName = "query_sector_conviction_leaderboard";

export type PgCapabilityRunInput = {
  classification: Classification;
  message: string;
  snapshots: SnapshotBundle;
  toolOutputs: ToolOutputs;
};

export type PgCapabilityViews = {
  sectorLeaderboardView?: SectorLeaderboardView;
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
    | "pg_sector_analog_bucket";
  freshnessSources: string[];
  fallback: "unavailable_empty_rows";
  sanitizer: "public_safe_capability_view";
  run: (input: PgCapabilityRunInput) => Promise<PgCapabilityRunResult>;
};

export type CapabilityFreshnessSource = {
  name: string;
  completedAt?: string;
  state?: string;
};

export type CapabilityFreshness = FreshnessMetadata & {
  state?: "fresh" | "stale" | "unknown";
  sources?: CapabilityFreshnessSource[];
};

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

export type EmptyCapabilityView = {
  viewSchemaVersion: number;
  state: EvidenceState;
  rows: [];
  warnings: string[];
};
