import type { Intent } from "../types";
import { buildSectorConvictionLeaderboardView } from "./sectorConvictionLeaderboard";
import { buildSectorDivergenceView } from "./sectorDivergence";
import { buildStockIdeaDiscoveryView } from "./stockIdeaDiscovery";
import type {
  PgCapabilityRegistryEntry,
  PgCapabilityRunInput,
  PgCapabilityRunResult,
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
  },
];

const REGISTRY_BY_INTENT = new Map<Intent, PgCapabilityRegistryEntry>(
  PG_CAPABILITY_REGISTRY.map((entry) => [entry.intent, entry]),
);

export function capabilityForIntent(
  intent: Intent,
): PgCapabilityRegistryEntry | undefined {
  return REGISTRY_BY_INTENT.get(intent);
}

export async function executePgCapabilities(
  input: PgCapabilityRunInput,
): Promise<PgCapabilityRunResult> {
  const entry = capabilityForIntent(input.classification.intent);
  if (!entry) return { views: {}, warnings: [] };
  return entry.run(input);
}
