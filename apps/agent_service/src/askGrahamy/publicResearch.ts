import type {
  Classification,
  ConversationContext,
  PublicResearchView,
  SnapshotBundle,
  ToolOutputs,
  CachedResearchObject,
} from "./types";
import {
  sectorContextFromResearchObjects,
  stockContextFromResearchObjects,
} from "./researchObjectBuilder";

export function compilePublicResearchView(input: {
  classification: Classification;
  previousContext?: ConversationContext;
  snapshots: SnapshotBundle;
  toolOutputs: ToolOutputs;
  researchObjects?: CachedResearchObject[];
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
    researchObjects,
    researchObjectKeys,
    evidence: {
      snapshotNames: ["daily_brief", "metadata", "clusters", "track_record", "transparency"].filter(
        (name) => !!snapshots[name as keyof SnapshotBundle],
      ),
      stockEvidenceCount: stockContext.symbols.reduce((sum, item) => sum + (item.evidenceCount ?? 0), 0),
      sectorCount: sectorContext.sectors.length,
      researchObjectCount: researchObjects.length,
      researchObjectSources: Array.from(new Set(researchObjects.map((item) => item.source))),
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
  const hasStock = classification.symbols.length > 0;
  const hasSector = classification.sectors.length > 0;
  const hasRegime = classification.regimeRequested;
  if ((hasStock && hasSector) || (hasStock && hasRegime) || (hasSector && hasRegime)) return "mixed";
  if (hasStock) return "stock";
  if (hasSector) return "sector";
  if (hasRegime) return "regime";
  return "mixed";
}
