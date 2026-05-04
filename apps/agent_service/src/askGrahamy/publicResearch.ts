import type {
  Classification,
  ConversationContext,
  PublicResearchView,
  SnapshotBundle,
  ToolOutputs,
  CachedResearchObject,
  PgCapabilityViews,
} from "./types";
import {
  publicObjectViewFromCachedObject,
  sectorContextFromResearchObjects,
  stockContextFromResearchObjects,
} from "./researchObjectBuilder";

export function compilePublicResearchView(input: {
  classification: Classification;
  previousContext?: ConversationContext;
  snapshots: SnapshotBundle;
  toolOutputs: ToolOutputs;
  researchObjects?: CachedResearchObject[];
  pgCapabilityViews?: PgCapabilityViews;
  warnings: string[];
}): PublicResearchView {
  const { classification, snapshots, toolOutputs, warnings } = input;
  const researchObjects = input.researchObjects ?? [];
  const objectType = inferObjectType(classification);
  const marketContext = toolOutputs.get_market_context ?? {};
  const fallbackStockContext = toolOutputs.get_stock_snapshot_context ?? {
    symbols: [],
    missingSymbols: classification.symbols,
  };
  const fallbackSectorContext = toolOutputs.get_sector_snapshot_context ?? {
    sectors: [],
    missingSectors: classification.sectors,
  };
  const stockContext = stockContextFromResearchObjects(
    researchObjects,
    fallbackStockContext,
  );
  const sectorContext = sectorContextFromResearchObjects(
    researchObjects,
    fallbackSectorContext,
  );
  const researchObjectKeys = researchObjects.map((item) => item.cacheKey);
  const researchObjectViews = researchObjects.map(publicObjectViewFromCachedObject);
  const pgCapabilityViewNames = [
    ...(input.pgCapabilityViews?.sectorLeaderboardView
      ? ["sectorLeaderboardView"]
      : []),
    ...(input.pgCapabilityViews?.sectorDivergenceView
      ? ["sectorDivergenceView"]
      : []),
    ...(input.pgCapabilityViews?.stockIdeaView ? ["stockIdeaView"] : []),
  ];

  return {
    objectType,
    headline: {
      intent: classification.intent,
      symbols: classification.symbols,
      sectors: classification.sectors,
      regime: marketContext.regime,
      researchObjectKeys,
    },
    marketContext,
    stockContext,
    sectorContext,
    researchObjectViews,
    researchObjectKeys,
    probabilisticEvidence: Object.fromEntries(
      researchObjectViews.map((item) => [item.cacheKey, item.probabilisticEvidence]),
    ),
    pathRisk: Object.fromEntries(
      researchObjectViews.map((item) => [item.cacheKey, item.pathRisk]),
    ),
    edgeEvidence: Object.fromEntries(
      researchObjectViews.map((item) => [item.cacheKey, item.edgeEvidence]),
    ),
    ...(input.pgCapabilityViews?.sectorLeaderboardView
      ? { sectorLeaderboardView: input.pgCapabilityViews.sectorLeaderboardView }
      : {}),
    ...(input.pgCapabilityViews?.sectorDivergenceView
      ? { sectorDivergenceView: input.pgCapabilityViews.sectorDivergenceView }
      : {}),
    ...(input.pgCapabilityViews?.stockIdeaView
      ? { stockIdeaView: input.pgCapabilityViews.stockIdeaView }
      : {}),
    evidence: {
      snapshotNames: ["daily_brief", "metadata", "clusters", "track_record", "transparency"].filter(
        (name) => !!snapshots[name as keyof SnapshotBundle],
      ),
      stockEvidenceCount: stockContext.symbols.reduce((sum, item) => sum + (item.evidenceCount ?? 0), 0),
      sectorCount: sectorContext.sectors.length,
      researchObjectCount: researchObjects.length,
      completeResearchObjectCount: researchObjectViews.length,
      edgeEvidenceStates: Object.fromEntries(
        researchObjectViews.map((item) => [item.cacheKey, item.edgeEvidence.state]),
      ),
      pathRiskStates: Object.fromEntries(
        researchObjectViews.map((item) => [item.cacheKey, item.pathRisk.state]),
      ),
      researchObjectSources: Array.from(new Set(researchObjects.map((item) => item.source))),
      ...(pgCapabilityViewNames.length
        ? { pgCapabilityViews: pgCapabilityViewNames }
        : {}),
      ...(input.pgCapabilityViews?.sectorLeaderboardView
        ? {
            sectorLeaderboardState:
              input.pgCapabilityViews.sectorLeaderboardView.state,
            sectorLeaderboardRows:
              input.pgCapabilityViews.sectorLeaderboardView.rows.length,
          }
        : {}),
      ...(input.pgCapabilityViews?.sectorDivergenceView
        ? {
            sectorDivergenceState:
              input.pgCapabilityViews.sectorDivergenceView.state,
            sectorDivergenceRows:
              input.pgCapabilityViews.sectorDivergenceView.rows.length,
          }
        : {}),
      ...(input.pgCapabilityViews?.stockIdeaView
        ? {
            stockIdeaState: input.pgCapabilityViews.stockIdeaView.state,
            stockIdeaRows: input.pgCapabilityViews.stockIdeaView.rows.length,
          }
        : {}),
    },
    freshness: snapshots.freshness ?? {},
    warnings: [
      ...warnings,
      ...Object.values(snapshots.errors ?? {}),
      ...(stockContext.missingSymbols.length
        ? [`No published snapshot context found for ${stockContext.missingSymbols.join(", ")}.`]
        : []),
      ...(sectorContext.missingSectors.length
        ? [`No published sector context found for ${sectorContext.missingSectors.join(", ")}.`]
        : []),
      ...(snapshots.freshness?.staleReason ? [snapshots.freshness.staleReason] : []),
    ].filter(Boolean),
  };
}

function inferObjectType(classification: Classification): PublicResearchView["objectType"] {
  if (classification.intent === "sector_conviction_leaderboard") return "sector";
  if (classification.intent === "sector_momentum_vs_conviction_divergence") return "sector";
  if (classification.intent === "stock_idea_discovery") return "stock";
  const hasStock = classification.symbols.length > 0;
  const hasSector = classification.sectors.length > 0;
  const hasRegime = classification.regimeRequested;
  if ((hasStock && hasSector) || (hasStock && hasRegime) || (hasSector && hasRegime)) return "mixed";
  if (hasStock) return "stock";
  if (hasSector) return "sector";
  if (hasRegime) return "regime";
  return "mixed";
}
