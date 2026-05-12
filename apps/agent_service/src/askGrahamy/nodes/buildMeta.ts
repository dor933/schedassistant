import type {
  CachedResearchObject,
  Classification,
  PgCapabilityViews,
  PipelineOverlayViews,
  ResponseMeta,
  SnapshotBundle,
  ToolName,
} from "../types";
import { EMPTY_CLASSIFICATION } from "../types";
import {
  type AskGrahamyGraphState,
  type AskGrahamyLangGraphState,
  type CachedCapabilityView,
  patchFromAskGrahamyState,
  runGraphNode,
  toAskGrahamyState,
} from "../state/askGrahamyState";

export async function buildMetaNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    next.meta = buildMeta(
      next.selectedTools ?? [],
      next.snapshots ?? {},
      next.warnings,
      next.classification ?? EMPTY_CLASSIFICATION,
      next.researchObjects ?? [],
      next.researchObjectCacheStats,
      next.researchObjectsUpdated ?? [],
      next.pgCapabilityViews,
      next.capabilityViewsUpdated ?? [],
      next.capabilityViewCacheStats,
      next.pipelineOverlayViews,
    );
    return patchFromAskGrahamyState(next);
  });
}

export function buildMeta(
  toolsUsed: ToolName[],
  snapshots: SnapshotBundle,
  warnings: string[],
  classification: Classification,
  researchObjects: CachedResearchObject[] = [],
  researchObjectCacheStats?: ResponseMeta["researchObjectCache"],
  researchObjectsUpdated: CachedResearchObject[] = [],
  pgCapabilityViews?: PgCapabilityViews,
  capabilityViewsUpdated: CachedCapabilityView[] = [],
  capabilityViewCacheStats?: ResponseMeta["capabilityViewCache"],
  pipelineOverlayViews?: PipelineOverlayViews,
): ResponseMeta {
  // Composite identifier for a capability view — replaces the old flat
  // `cacheKey` string. Used in `meta.capabilityViewKeys` purely for
  // telemetry / debugging.
  function identifyCapabilityView(item: CachedCapabilityView): string {
    const anchor =
      item.anchorSector ?? item.anchorIndustry ?? item.anchorSymbol ?? "";
    const discriminator = item.rankingBasis ?? item.criteriaHash ?? "";
    return [item.capabilityName, item.asOfDate, anchor, discriminator]
      .filter(Boolean)
      .join(":");
  }
  // Only research objects are "sources" the answer was actually grounded in.
  // Snapshots are background scaffolding the graph fetches for system-prompt
  // context — the agent never quotes them, so listing them as numbered
  // citations in the UI was misleading. Snapshot fetch state is still
  // captured in `freshness` / `upstreamLatency` for telemetry.
  const researchSources = researchObjects.map((item) => ({
    type: "research" as const,
    name: item.cacheKey,
  }));
  const capabilitySources: Array<{ type: "research"; name: string }> = [];
  if (pgCapabilityViews?.sectorLeaderboardView) {
    capabilitySources.push({ type: "research", name: "sector_conviction_leaderboard" });
  }
  if (pgCapabilityViews?.sectorDivergenceView) {
    capabilitySources.push({
      type: "research",
      name: "sector_momentum_vs_conviction_divergence",
    });
  }
  if (pgCapabilityViews?.sectorDeltaView) {
    capabilitySources.push({
      type: "research",
      name: "week_over_week_sector_delta",
    });
  }
  if (pgCapabilityViews?.stockIdeaView) {
    // The same view slot is filled by both stock_idea_discovery (org-wide)
    // and sector_leaders (sector-internal). The intent disambiguates which
    // capability produced it.
    capabilitySources.push({
      type: "research",
      name:
        classification.intent === "sector_leaders"
          ? "sector_leaders"
          : "stock_idea_discovery",
    });
  }
  if (pgCapabilityViews?.featureScreenView) {
    capabilitySources.push({ type: "research", name: "feature_screen" });
  }
  if (pgCapabilityViews?.factorBacktestView) {
    capabilitySources.push({
      type: "research",
      name: "factor_conditioned_backtest",
    });
  }
  if (pgCapabilityViews?.regimeHistoricalPlaybookView) {
    capabilitySources.push({
      type: "research",
      name: "market_regime_historical_playbook",
    });
  }
  if (pipelineOverlayViews?.validatedEdgeEvidenceView) {
    capabilitySources.push({
      type: "research",
      name: "validated_edge_evidence",
    });
  }
  return {
    sourcesUsed: [...researchSources, ...capabilitySources],
    freshness: snapshots.freshness ?? {},
    warnings: Array.from(
      new Set([
        ...warnings,
        ...classification.warnings,
        ...Object.values(snapshots.errors ?? {}),
      ]),
    ),
    toolsUsed,
    researchObjectKeys: researchObjects.map((item) => item.cacheKey),
    researchObjectCache: researchObjectCacheStats,
    researchObjectsUpdated: researchObjectsUpdated.length
      ? researchObjectsUpdated
      : undefined,
    capabilityViewKeys: capabilityViewsUpdated.length
      ? capabilityViewsUpdated.map((item) => identifyCapabilityView(item))
      : undefined,
    capabilityViewCache: capabilityViewCacheStats,
    capabilityViewsUpdated: capabilityViewsUpdated.length
      ? capabilityViewsUpdated
      : undefined,
    upstreamLatency: snapshots.latencyMs,
  };
}
