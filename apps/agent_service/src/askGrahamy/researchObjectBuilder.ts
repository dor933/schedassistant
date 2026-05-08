import { logger } from "../logger";
import { isRecord, stringValue } from "./snapshotClient";
import { runResearchQuery } from "./researchQueryClient";
import { queryExternalReadonly } from "../utils/externalReadonlyDb";
import { PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION } from "./types";
import type {
  CachedResearchObject,
  EdgeEvidenceView,
  EvidenceClaim,
  Classification,
  FreshnessMetadata,
  MarketContext,
  PathRiskView,
  ProbabilisticEvidenceView,
  ProbabilisticReferenceSet,
  PublicResearchObjectView,
  SectorLandscape,
  SnapshotBundle,
  StockResearchContext,
  ToolOutputs,
} from "./types";

export function buildResearchObjectCacheKey(
  objectType: "STOCK" | "SECTOR" | "REGIME",
  anchor: string,
  asOfDate: string,
): string {
  return `${objectType}:${anchor.toUpperCase()}:${asOfDate}`;
}

/** Index prior objects by cache_key for O(1) lookup during the build loop. */
function indexPriorObjects(
  priors: CachedResearchObject[] | undefined,
): Map<string, CachedResearchObject> {
  const index = new Map<string, CachedResearchObject>();
  if (!priors) return index;
  for (const obj of priors) {
    if (!obj?.cacheKey) continue;
    index.set(obj.cacheKey, obj);
  }
  return index;
}

export type ResearchObjectBuildResult = {
  /** Every object used to compose the answer (prior + freshly built). */
  objects: CachedResearchObject[];
  /**
   * Subset of `objects` that need persistence by the upstream caller —
   * either freshly built this turn or augmented with new fields. Cache
   * hits (used as-is from priorResearchObjects) are NOT included.
   */
  objectsUpdated: CachedResearchObject[];
  stats: { hits: number; misses: number; writes: number };
  warnings: string[];
};

export async function buildResearchObjects(input: {
  classification: Classification;
  snapshots: SnapshotBundle;
  toolOutputs: ToolOutputs;
  /** Research objects the upstream caller already had cached for the
   * current asOfDate — skip the v6 SQL build for any cache_key found here. */
  priorResearchObjects?: CachedResearchObject[];
}): Promise<ResearchObjectBuildResult> {
  const { classification, snapshots, toolOutputs, priorResearchObjects } = input;
  const stats = { hits: 0, misses: 0, writes: 0 };
  const warnings: string[] = [];
  const objects: CachedResearchObject[] = [];
  const objectsUpdated: CachedResearchObject[] = [];
  const priorIndex = indexPriorObjects(priorResearchObjects);

  if (!isResearchDbConfigured()) {
    return { objects, objectsUpdated, stats, warnings };
  }

  const asOfDate = researchObjectDate(snapshots.freshness);

  for (const symbol of classification.symbols) {
    const cacheKey = buildResearchObjectCacheKey("STOCK", symbol, asOfDate);
    const prior = priorIndex.get(cacheKey);
    if (prior) {
      const hydrated = hydrateCachedResearchObjectView(prior);
      if (hydrated) {
        stats.hits += 1;
        objects.push(hydrated.object);
        if (hydrated.updated) {
          objectsUpdated.push(hydrated.object);
          stats.writes += 1;
        }
        continue;
      }
      warnings.push(`Cached Research Object for ${symbol} is stale and cannot be safely hydrated; rebuilding.`);
    }

    stats.misses += 1;
    try {
      const stockObject = await buildStockResearchObject({
        symbol,
        asOfDate,
        freshness: snapshots.freshness ?? {},
        snapshotContext: toolOutputs.get_stock_snapshot_context,
      });
      objects.push(stockObject);
      objectsUpdated.push(stockObject);
      stats.writes += 1;
    } catch (err) {
      const message = `Research Object query failed for ${symbol}.`;
      warnings.push(message);
      logger.warn("Ask Grahamy stock Research Object build failed", {
        symbol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const sector of classification.sectors) {
    const cacheKey = buildResearchObjectCacheKey("SECTOR", sector, asOfDate);
    const prior = priorIndex.get(cacheKey);
    if (prior) {
      const hydrated = hydrateCachedResearchObjectView(prior);
      if (hydrated) {
        stats.hits += 1;
        objects.push(hydrated.object);
        if (hydrated.updated) {
          objectsUpdated.push(hydrated.object);
          stats.writes += 1;
        }
        continue;
      }
      warnings.push(`Cached Research Object for sector ${sector} is stale and cannot be safely hydrated; rebuilding.`);
    }

    stats.misses += 1;
    try {
      const sectorObject = await buildSectorResearchObject({
        sector,
        asOfDate,
        freshness: snapshots.freshness ?? {},
        snapshotContext: toolOutputs.get_sector_snapshot_context,
      });
      objects.push(sectorObject);
      objectsUpdated.push(sectorObject);
      stats.writes += 1;
    } catch (err) {
      const message = `Sector Research Object query failed for ${sector}.`;
      warnings.push(message);
      logger.warn("Ask Grahamy sector Research Object build failed", {
        sector,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // The regime Research Object is loaded for every turn — it is the canonical
  // source of the current market regime label that the system prompt and the
  // analyst layer reason from. Pipeline `daily_brief` is only supplemental.
  {
    const regime = await resolveCurrentRegime(toolOutputs.get_market_context, objects);
    if (regime) {
      const cacheKey = buildResearchObjectCacheKey("REGIME", "MARKET", asOfDate);
      const prior = priorIndex.get(cacheKey);
      if (prior) {
        const hydrated = hydrateCachedResearchObjectView(prior);
        if (hydrated) {
          stats.hits += 1;
          objects.push(hydrated.object);
          if (hydrated.updated) {
            objectsUpdated.push(hydrated.object);
            stats.writes += 1;
          }
        } else {
          warnings.push("Cached regime Research Object is stale and cannot be safely hydrated; rebuilding.");
          stats.misses += 1;
          try {
            const regimeObject = await buildRegimeResearchObject({
              regime,
              asOfDate,
              freshness: snapshots.freshness ?? {},
            });
            objects.push(regimeObject);
            objectsUpdated.push(regimeObject);
            stats.writes += 1;
          } catch (err) {
            warnings.push(`Regime Research Object query failed for ${regime}.`);
            logger.warn("Ask Grahamy regime Research Object build failed", {
              regime,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else {
        stats.misses += 1;
        try {
          const regimeObject = await buildRegimeResearchObject({
            regime,
            asOfDate,
            freshness: snapshots.freshness ?? {},
          });
          objects.push(regimeObject);
          objectsUpdated.push(regimeObject);
          stats.writes += 1;
        } catch (err) {
          warnings.push(`Regime Research Object query failed for ${regime}.`);
          logger.warn("Ask Grahamy regime Research Object build failed", {
            regime,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  return { objects, objectsUpdated, stats, warnings };
}

/**
 * Anchorless capabilities pick a list of stocks/sectors via SQL and then need
 * the SAME deep research-object payload that anchored answers see — same
 * cache, same shape, no second POV. This wrapper synthesises the minimum
 * Classification needed to call `buildResearchObjects` so capabilities don't
 * fabricate one inline.
 */
export type BuildForAnchorsInput = {
  symbols?: string[];
  sectors?: string[];
  regimeRequested?: boolean;
  snapshots: SnapshotBundle;
  toolOutputs?: ToolOutputs;
  priorResearchObjects?: CachedResearchObject[];
};

export async function buildResearchObjectsForAnchors(
  input: BuildForAnchorsInput,
): Promise<ResearchObjectBuildResult> {
  const symbols = uniqueUpperList(input.symbols).slice(0, 25);
  const sectors = uniqueList(input.sectors).slice(0, 15);
  const regimeRequested = input.regimeRequested === true;

  if (!symbols.length && !sectors.length && !regimeRequested) {
    return {
      objects: [],
      objectsUpdated: [],
      stats: { hits: 0, misses: 0, writes: 0 },
      warnings: [],
    };
  }

  const classification: Classification = {
    intent: "stock",
    symbols,
    sectors,
    regimeRequested,
    isFollowUp: false,
    requiresTools: [],
    confidence: "medium",
    warnings: [],
  };
  return buildResearchObjects({
    classification,
    snapshots: input.snapshots,
    toolOutputs: input.toolOutputs ?? {},
    priorResearchObjects: input.priorResearchObjects,
  });
}

function uniqueUpperList(values: string[] | undefined): string[] {
  if (!values?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value?.trim().toUpperCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function uniqueList(values: string[] | undefined): string[] {
  if (!values?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function stockContextFromResearchObjects(
  objects: CachedResearchObject[],
  fallback: StockResearchContext,
): StockResearchContext {
  const stockObjects = objects.filter((item) => item.objectType === "stock");
  if (!stockObjects.length) return fallback;

  return {
    symbols: stockObjects.map((item) => {
      const summary = item.publicSummary;
      return {
        symbol: item.anchor,
        company: stringFrom(summary.company),
        sector: stringFrom(summary.sector),
        convergenceScore: numberFrom(summary.convergence),
        confluenceLevel: stringFrom(summary.evidenceBadge) ?? "RESEARCH_OBJECT",
        evidenceCount: numberFrom(summary.evidenceCount),
        notableEvents: eventRowsFromSummary(summary),
        completedWinRateBucket: stringFrom(summary.historicalEvidence),
      };
    }),
    missingSymbols: fallback.missingSymbols.filter(
      (symbol) => !stockObjects.some((item) => item.anchor === symbol),
    ),
  };
}

export function sectorContextFromResearchObjects(
  objects: CachedResearchObject[],
  fallback: SectorLandscape,
): SectorLandscape {
  const sectorObjects = objects.filter((item) => item.objectType === "sector");
  if (!sectorObjects.length) return fallback;

  return {
    sectors: sectorObjects.map((item) => ({
      sector: item.anchor,
      stocksInFocus: numberFrom(item.publicSummary.stocksInFocus) ?? 0,
      exampleSymbols: arrayOfStrings(item.publicSummary.exampleSymbols),
      completedWinRateBucket: stringFrom(item.publicSummary.historicalEvidence),
    })),
    missingSectors: fallback.missingSectors.filter(
      (sector) => !sectorObjects.some((item) => item.anchor === sector),
    ),
  };
}

async function buildStockResearchObject(input: {
  symbol: string;
  asOfDate: string;
  freshness: FreshnessMetadata;
  snapshotContext?: StockResearchContext;
}): Promise<CachedResearchObject> {
  const symbol = input.symbol.toUpperCase();
  const [coreRow, qualityRow] = await Promise.all([
    runResearchQuery<{ research_object_core?: unknown }>("query_v6a_core_live", {
      SYMBOL: symbol,
    }),
    runResearchQuery<{ research_object_v6c?: unknown }>(
      "query_v6c_financial_quality",
      { SYMBOL: symbol },
    ),
  ]);

  const core = asRecord(coreRow?.research_object_core);
  if (!Object.keys(core).length) {
    throw new Error(`No core Research Object row returned for ${symbol}.`);
  }
  const profileKeys = asRecord(core.profile_keys);
  const sectorAggregates = await buildSectorAggregates(symbol, profileKeys);
  const quality = asRecord(qualityRow?.research_object_v6c);
  const snapshotStock = input.snapshotContext?.symbols.find(
    (item) => item.symbol.toUpperCase() === symbol,
  );

  const cacheKey = buildResearchObjectCacheKey("STOCK", symbol, input.asOfDate);
  const publicSummary = buildStockSummary(
    core,
    sectorAggregates,
    quality,
    snapshotStock,
  );
  const view = buildStockPublicResearchObjectView({
    cacheKey,
    symbol,
    asOfDate: stringValue(asRecord(core.meta).as_of_date) ?? input.asOfDate,
    freshness: input.freshness,
    publicSummary,
    core,
    sectorAggregates,
    quality,
    snapshotStock,
    fullResearchObject: undefined,
    warnings: [],
  });
  return {
    cacheKey,
    objectType: "stock",
    anchor: symbol,
    asOfDate: stringValue(asRecord(core.meta).as_of_date) ?? input.asOfDate,
    generatedAt: new Date().toISOString(),
    source: "database",
    publicSummary: {
      ...publicSummary,
      edgeEvidence: view.edgeEvidence,
      probabilisticEvidence: view.probabilisticEvidence,
      pathRisk: view.pathRisk,
    },
    parts: {
      core: sanitizeResearchPart(core),
      sectorAggregates: sanitizeResearchPart(sectorAggregates),
      financialQuality: sanitizeResearchPart(quality),
      snapshot: snapshotStock,
    },
    view,
    freshness: input.freshness,
    warnings: [],
  };
}

async function buildSectorAggregates(
  symbol: string,
  profileKeys: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sector = stringValue(profileKeys.sector);
  const regime = stringValue(profileKeys.current_regime);
  const valuationBucket = stringValue(profileKeys.valuation_bucket);
  const peBin = numberFrom(profileKeys.pe_bin);
  const rsiBin = numberFrom(profileKeys.rsi_bin);

  if (!sector || !regime || !valuationBucket || peBin == null || rsiBin == null) {
    return {};
  }

  const row = await runResearchQuery<{ research_object_sector?: unknown }>(
    "query_v6b_sector_aggregates",
    {
      SYMBOL: symbol,
      SECTOR: sector,
      CURRENT_REGIME: regime,
      PE_BIN: peBin,
      RSI_BIN: rsiBin,
      VALUATION_BUCKET: valuationBucket,
    },
  );
  return asRecord(row?.research_object_sector);
}

async function buildSectorResearchObject(input: {
  sector: string;
  asOfDate: string;
  freshness: FreshnessMetadata;
  snapshotContext?: SectorLandscape;
}): Promise<CachedResearchObject> {
  const row = await runResearchQuery<{ research_object?: unknown }>(
    "query_v6a_sector_live",
    { SECTOR: input.sector },
  );
  const researchObject = asRecord(row?.research_object);
  if (!Object.keys(researchObject).length) {
    throw new Error(`No sector Research Object row returned for ${input.sector}.`);
  }
  const snapshotSector = input.snapshotContext?.sectors.find(
    (item) => normalize(item.sector) === normalize(input.sector),
  );
  const cacheKey = buildResearchObjectCacheKey("SECTOR", input.sector, input.asOfDate);
  const asOfDate = stringValue(asRecord(researchObject.meta).as_of_date) ?? input.asOfDate;
  const publicSummary = buildSectorSummary(researchObject, snapshotSector);
  const view = buildSectorPublicResearchObjectView({
    cacheKey,
    sector: input.sector,
    asOfDate,
    freshness: input.freshness,
    publicSummary,
    researchObject,
  });

  return {
    cacheKey,
    objectType: "sector",
    anchor: input.sector,
    asOfDate,
    generatedAt: new Date().toISOString(),
    source: "database",
    publicSummary: {
      ...publicSummary,
      edgeEvidence: view.edgeEvidence,
      probabilisticEvidence: view.probabilisticEvidence,
      pathRisk: view.pathRisk,
    },
    parts: { sector: sanitizeResearchPart(researchObject), snapshot: snapshotSector },
    view,
    freshness: input.freshness,
    warnings: [],
  };
}

async function buildRegimeResearchObject(input: {
  regime: string;
  asOfDate: string;
  freshness: FreshnessMetadata;
}): Promise<CachedResearchObject> {
  const row = await runResearchQuery<{ research_object?: unknown }>(
    "query_v6a_regime_live",
    { REGIME: input.regime },
  );
  const researchObject = asRecord(row?.research_object);
  if (!Object.keys(researchObject).length) {
    throw new Error(`No regime Research Object row returned for ${input.regime}.`);
  }
  const cacheKey = buildResearchObjectCacheKey("REGIME", "MARKET", input.asOfDate);
  const asOfDate = stringValue(asRecord(researchObject.meta).as_of_date) ?? input.asOfDate;
  const publicSummary = buildRegimeSummary(researchObject, input.regime);
  const view = buildRegimePublicResearchObjectView({
    cacheKey,
    asOfDate,
    freshness: input.freshness,
    publicSummary,
    researchObject,
  });

  return {
    cacheKey,
    objectType: "regime",
    anchor: "MARKET",
    asOfDate,
    generatedAt: new Date().toISOString(),
    source: "database",
    publicSummary: {
      ...publicSummary,
      edgeEvidence: view.edgeEvidence,
      probabilisticEvidence: view.probabilisticEvidence,
      pathRisk: view.pathRisk,
    },
    parts: { regime: sanitizeResearchPart(researchObject) },
    view,
    freshness: input.freshness,
    warnings: [],
  };
}

function buildStockSummary(
  core: Record<string, unknown>,
  sectorAggregates: Record<string, unknown>,
  quality: Record<string, unknown>,
  snapshotStock: StockResearchContext["symbols"][number] | undefined,
  fullResearchObject?: Record<string, unknown>,
): Record<string, unknown> {
  const meta = asRecord(core.meta);
  const regimeContext = asRecord(core.regime_context);
  const eventContext = asRecord(core.event_context);
  const trajectory = asRecord(core.trajectory);
  const companyState = asRecord(core.company_state);
  const analogSelf = asRecord(asRecord(core.analog_evidence_self).self_history);
  const portfolio = asRecord(sectorAggregates.portfolio_context);
  const sectorInvalidation = asRecord(sectorAggregates.invalidation);
  const liquidityTier = asRecord(quality.liquidity_tier);
  const growthCompound = asRecord(quality.growth_compound);
  const financialQuality = asRecord(quality.financial_quality);
  const forwardCatalysts = asRecord(quality.forward_catalysts);
  const capitalAllocation = asRecord(quality.capital_allocation);
  const peerRelativePerf = asRecord(quality.peer_relative_perf);

  const symbol = stringValue(meta.symbol) ?? snapshotStock?.symbol;
  const regime = stringValue(regimeContext.current_regime);
  const eventUrgency =
    stringValue(forwardCatalysts.next_earnings_window) ??
    stringValue(eventContext.earnings_proximity);

  const regimeFit = deriveRegimeFit(regimeContext);
  const forward = deriveForwardPerformance(analogSelf);
  const probabilisticEvidence = deriveProbabilisticEvidence(
    analogSelf,
    asRecord(sectorAggregates.analog_evidence_sector),
  );
  const pathRisk = derivePathRisk(
    analogSelf,
    asRecord(sectorAggregates.analog_evidence_sector),
    fullResearchObject,
  );
  const edgeEvidence = deriveEdgeEvidence(fullResearchObject, snapshotStock);
  const signals = deriveActiveSignals({
    trajectory,
    growthCompound,
    financialQuality,
    capitalAllocation,
    forwardCatalysts,
    eventContext,
    companyState,
  });
  const fundamentals = deriveFundamentalsSnapshot({
    liquidityTier,
    growthCompound,
    financialQuality,
    companyState,
    portfolio,
  });
  const upcomingEvents = deriveUpcomingEvents(forwardCatalysts, eventContext);
  const invalidationSignals = deriveInvalidationSignals({
    regimeContext,
    peerRelativePerf,
    forwardCatalysts,
    companyState,
    sectorInvalidation,
  });

  return {
    symbol,
    company: stringValue(meta.company_name) ?? snapshotStock?.company,
    sector: stringValue(meta.sector) ?? snapshotStock?.sector,
    asOfDate: stringValue(meta.as_of_date),

    // Regime context (bucketed only — no raw VIX numbers)
    regime,
    vixBand: stringValue(regimeContext.vix_band),
    regimeFit,                              // ALIGNED | CHALLENGED | UNCERTAIN
    regimeShiftDetected: regimeContext.regime_shift_detected === true,

    // Catalyst urgency
    eventUrgency,                           // e.g. WITHIN_5_DAYS

    // Provenance
    evidenceBadge: "RESEARCH_OBJECT_BACKED",
    evidenceCount: snapshotStock?.evidenceCount,
    convergence: snapshotStock?.convergenceScore,

    // Peer rank ONLY as a percentile bucket — peer symbols are intentionally
    // hidden per MOAT policy.
    peerRankPercentile: bucketPercentileRank(numberFrom(portfolio.composite_rank_in_sector)),

    // Active signals derived from PG-backed bands (Trajectory, Quality,
    // Capital Allocation, Catalyst). Note: these are NOT pipeline-validated
    // edges — that's a Phase 2 build per the Ask Grahamy plan.
    activeSignals: signals,
    edgeEvidence,

    // Forward performance — bucketed only.
    forwardPerformance: forward,
    probabilisticEvidence,
    pathRisk,

    // Fundamentals snapshot — buckets, not raw PE / revenue / market cap.
    fundamentalsSnapshot: fundamentals,

    upcomingEvents,
    invalidationSignals,

    historicalEvidence: stringValue(analogSelf.sample_adequacy),
    whyNow: buildWhyNowText({
      symbol,
      regime,
      regimeFit,
      eventUrgency,
      topSignal: signals[0],
    }),
  };
}

export function publicObjectViewFromCachedObject(
  item: CachedResearchObject,
): PublicResearchObjectView {
  if (isCurrentPublicObjectView(item.view)) return item.view;

  if (item.objectType === "stock") {
    return buildStockPublicResearchObjectView({
      cacheKey: item.cacheKey,
      symbol: item.anchor,
      asOfDate: item.asOfDate,
      freshness: item.freshness,
      publicSummary: item.publicSummary,
      core: asRecord(item.parts.core),
      sectorAggregates: asRecord(item.parts.sectorAggregates),
      quality: asRecord(item.parts.financialQuality),
      snapshotStock: undefined,
      fullResearchObject: undefined,
      warnings: item.warnings,
    });
  }

  if (item.objectType === "sector") {
    return buildSectorPublicResearchObjectView({
      cacheKey: item.cacheKey,
      sector: item.anchor,
      asOfDate: item.asOfDate,
      freshness: item.freshness,
      publicSummary: item.publicSummary,
      researchObject: asRecord(item.parts.sector),
    });
  }

  return buildRegimePublicResearchObjectView({
    cacheKey: item.cacheKey,
    asOfDate: item.asOfDate,
    freshness: item.freshness,
    publicSummary: item.publicSummary,
    researchObject: asRecord(item.parts.regime),
  });
}

function hydrateCachedResearchObjectView(
  item: CachedResearchObject,
): { object: CachedResearchObject; updated: boolean } | undefined {
  if (isCurrentPublicObjectView(item.view)) {
    return { object: item, updated: false };
  }
  if (!hasHydratableParts(item)) return undefined;
  const view = publicObjectViewFromCachedObject(item);
  return {
    object: {
      ...item,
      view,
      publicSummary: {
        ...item.publicSummary,
        edgeEvidence: view.edgeEvidence,
        probabilisticEvidence: view.probabilisticEvidence,
        pathRisk: view.pathRisk,
      },
      warnings: item.warnings ?? [],
    },
    updated: true,
  };
}

function isCurrentPublicObjectView(
  view: CachedResearchObject["view"] | unknown,
): view is PublicResearchObjectView {
  return (
    isRecord(view) &&
    numberFrom(view.viewSchemaVersion) === PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION
  );
}

function hasHydratableParts(item: CachedResearchObject): boolean {
  const parts = asRecord(item.parts);
  if (item.objectType === "stock") return Object.keys(asRecord(parts.core)).length > 0;
  if (item.objectType === "sector") return Object.keys(asRecord(parts.sector)).length > 0;
  if (item.objectType === "regime") return Object.keys(asRecord(parts.regime)).length > 0;
  return false;
}

function buildStockPublicResearchObjectView(input: {
  cacheKey: string;
  symbol: string;
  asOfDate: string;
  freshness: FreshnessMetadata;
  publicSummary: Record<string, unknown>;
  core: Record<string, unknown>;
  sectorAggregates: Record<string, unknown>;
  quality: Record<string, unknown>;
  snapshotStock?: StockResearchContext["symbols"][number];
  fullResearchObject?: Record<string, unknown>;
  warnings: string[];
}): PublicResearchObjectView {
  const analogSelf = asRecord(asRecord(input.core.analog_evidence_self).self_history);
  const analogSector = asRecord(input.sectorAggregates.analog_evidence_sector);
  const edgeEvidence = deriveEdgeEvidence(
    input.fullResearchObject,
    input.snapshotStock,
  );
  const probabilisticEvidence = deriveProbabilisticEvidence(
    analogSelf,
    analogSector,
  );
  const pathRisk = derivePathRisk(
    analogSelf,
    analogSector,
    input.fullResearchObject,
  );

  return {
    viewSchemaVersion: PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION,
    cacheKey: input.cacheKey,
    objectType: "stock",
    anchor: input.symbol,
    asOfDate: input.asOfDate,
    title: stringValue(input.publicSummary.company) ?? input.symbol,
    fiveQuestion: {
      whatMattersNow: buildStockWhatMattersNow(input.publicSummary),
      whyNow: stringValue(input.publicSummary.whyNow),
      historicalAnalogs: buildHistoricalAnalogBullets(
        probabilisticEvidence,
        "stock-local and sector-conditioned analogs",
      ),
      underWhichConditions: buildStockConditionBullets(input.sectorAggregates),
      invalidation: arrayOfStrings(input.publicSummary.invalidationSignals),
    },
    edgeEvidence,
    probabilisticEvidence,
    pathRisk,
    freshness: input.freshness,
    warnings: Array.from(new Set([...input.warnings, ...edgeEvidence.warnings])),
  };
}

function buildSectorPublicResearchObjectView(input: {
  cacheKey: string;
  sector: string;
  asOfDate: string;
  freshness: FreshnessMetadata;
  publicSummary: Record<string, unknown>;
  researchObject: Record<string, unknown>;
}): PublicResearchObjectView {
  const historicalBaseRate = asRecord(input.researchObject.historical_base_rate);
  const probabilisticEvidence = deriveAggregateProbabilisticEvidence(
    historicalBaseRate,
    "60-day",
  );
  const pathRisk = deriveSectorPathRisk(asRecord(input.researchObject));
  const edgeEvidence = unavailableEdgeEvidence(
    "Validated edge evidence is not yet bridged for sector Research Objects in Ask Grahamy.",
  );

  return {
    viewSchemaVersion: PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION,
    cacheKey: input.cacheKey,
    objectType: "sector",
    anchor: input.sector,
    asOfDate: input.asOfDate,
    title: input.sector,
    fiveQuestion: {
      whatMattersNow: buildSectorWhatMattersNow(input.publicSummary),
      whyNow: stringValue(input.publicSummary.whyNow),
      historicalAnalogs: buildHistoricalAnalogBullets(
        probabilisticEvidence,
        "sector base rate",
      ),
      underWhichConditions: [
        ...prefixList(
          "Favorable",
          arrayOfStrings(input.publicSummary.favorableConditions),
        ),
        ...prefixList(
          "Unfavorable",
          arrayOfStrings(input.publicSummary.unfavorableConditions),
        ),
      ],
      invalidation: [
        ...arrayOfStrings(input.publicSummary.invalidationSignals),
        input.publicSummary.currentRegimeBelowBest === true
          ? "Current regime is below the sector's best historical regime bucket."
          : undefined,
      ].filter((item): item is string => !!item),
    },
    edgeEvidence,
    probabilisticEvidence,
    pathRisk,
    freshness: input.freshness,
    warnings: edgeEvidence.warnings,
  };
}

function buildRegimePublicResearchObjectView(input: {
  cacheKey: string;
  asOfDate: string;
  freshness: FreshnessMetadata;
  publicSummary: Record<string, unknown>;
  researchObject: Record<string, unknown>;
}): PublicResearchObjectView {
  const historicalBaseRate = asRecord(input.researchObject.historical_base_rate);
  const regime = stringValue(input.publicSummary.regime) ?? "MARKET";
  const probabilisticEvidence = deriveAggregateProbabilisticEvidence(
    historicalBaseRate,
    "60-day",
  );
  const pathRisk = deriveRegimePathRisk(asRecord(input.researchObject));
  const edgeEvidence = unavailableEdgeEvidence(
    "Validated edge evidence is not yet bridged for regime Research Objects in Ask Grahamy.",
  );

  return {
    viewSchemaVersion: PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION,
    cacheKey: input.cacheKey,
    objectType: "regime",
    anchor: "MARKET",
    asOfDate: input.asOfDate,
    title: regime,
    fiveQuestion: {
      whatMattersNow: buildRegimeWhatMattersNow(input.publicSummary),
      whyNow: stringValue(input.publicSummary.whyNow),
      historicalAnalogs: buildHistoricalAnalogBullets(
        probabilisticEvidence,
        "regime base rate",
      ),
      underWhichConditions: [
        ...prefixSectorBuckets(
          "Historically stronger sectors",
          input.publicSummary.topSectorsHistorical,
        ),
        ...prefixSectorBuckets(
          "Historically weaker sectors",
          input.publicSummary.bottomSectorsHistorical,
        ),
      ],
      invalidation: arrayOfStrings(input.publicSummary.invalidationSignals),
    },
    edgeEvidence,
    probabilisticEvidence,
    pathRisk,
    freshness: input.freshness,
    warnings: edgeEvidence.warnings,
  };
}

function deriveEdgeEvidence(
  fullResearchObject: Record<string, unknown> | undefined,
  snapshotStock: StockResearchContext["symbols"][number] | undefined,
): EdgeEvidenceView {
  const fullEdge = asRecord(fullResearchObject?.edge_evidence);
  const fullClaims = Array.isArray(fullEdge.claims)
    ? fullEdge.claims.filter(isRecord)
    : [];
  const claims: EvidenceClaim[] = [];
  for (const claim of fullClaims) {
    const text = stringValue(claim.text);
    if (!text) continue;
    const next: EvidenceClaim = { text, source: "validated_pipeline" };
    const classification = stringValue(claim.classification);
    const family = stringValue(claim.derivation);
    if (classification) next.classification = classification;
    if (family) next.family = family;
    claims.push(next);
    if (claims.length >= 8) break;
  }

  if (claims.length) {
    const rollingForwardValidation = claims.filter((claim) =>
      /sentinel|rolling|horizon|validated/i.test(
        `${claim.family ?? ""} ${claim.text}`,
      ),
    );
    const decay = claims.find((claim) =>
      /coroner|decay/i.test(`${claim.family ?? ""} ${claim.text}`),
    );
    const density = claims.find((claim) =>
      /density/i.test(`${claim.family ?? ""} ${claim.text}`),
    );
    const convergence = claims.find((claim) =>
      /convergence|famil/i.test(`${claim.family ?? ""} ${claim.text}`),
    );

    return {
      state: "complete",
      source: "validated_pipeline",
      claims,
      convergence: convergence
        ? {
            label: convergence.classification,
            familyCountBucket: convergence.text,
          }
        : undefined,
      rollingForwardValidation,
      decayState: decay?.classification ?? decay?.text,
      sectorSignalDensity: density?.classification ?? density?.text,
      warnings: [],
    };
  }

  if (snapshotStock?.confluenceLevel || snapshotStock?.convergenceScore != null) {
    return {
      state: "partial",
      source: "snapshot_proxy",
      claims: [
        {
          text: "Published snapshot context shows a convergence read for this name, but the validated edge bridge did not return full edge evidence.",
          classification: snapshotStock.confluenceLevel,
          source: "snapshot_proxy",
        },
      ],
      convergence: {
        label: snapshotStock.confluenceLevel,
        familyCountBucket:
          snapshotStock.convergenceScore == null
            ? undefined
            : bucketConvergenceCount(snapshotStock.convergenceScore),
      },
      rollingForwardValidation: [],
      warnings: [
        "Validated edge evidence bridge unavailable; using snapshot convergence proxy.",
      ],
    };
  }

  return unavailableEdgeEvidence("No validated edge evidence returned for this anchor.");
}

function deriveProbabilisticEvidence(
  selfAnalog: Record<string, unknown>,
  sectorAnalog: Record<string, unknown>,
): ProbabilisticEvidenceView {
  const selfHitRate = numberFrom(selfAnalog.h60_hit_rate);
  const sectorHitRate = numberFrom(sectorAnalog.h60_hit_rate);
  const referenceSet: ProbabilisticReferenceSet | undefined =
    selfHitRate != null
      ? "self_analogs"
      : sectorHitRate != null
      ? "sector_conditioned_analogs"
      : undefined;
  const selected = referenceSet === "sector_conditioned_analogs" ? sectorAnalog : selfAnalog;
  const sampleAdequacy = stringValue(selected.sample_adequacy);
  const sampleSize =
    numberFrom(selected.n_with_h60) ??
    numberFrom(selected.n);
  const hitRate = numberFrom(selected.h60_hit_rate);
  const median = numberFrom(selected.h60_median_pct);
  const p25 = numberFrom(selected.h60_p25_pct);
  const p75 = numberFrom(selected.h60_p75_pct);
  const sectorMedian = numberFrom(sectorAnalog.h60_median_pct);

  return {
    viewSchemaVersion: PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION,
    state: hitRate == null && sectorHitRate == null ? "unavailable" : "complete",
    horizon: "60-day",
    referenceSet,
    sampleSize,
    hitRatePct: hitRate,
    medianReturnPct: median,
    p25ReturnPct: p25,
    p75ReturnPct: p75,
    sampleAdequacy,
    hitRateBucket: bucketHitRatePct(hitRate),
    medianOutcomeBucket: bucketMedianOutcomePct(median),
    downsideQuartileBucket: bucketTailOutcomePct(p25),
    upsideQuartileBucket: bucketTailOutcomePct(p75),
    conditionedHitRateBucket: bucketHitRatePct(sectorHitRate),
    conditionedOutcomeBucket: bucketMedianOutcomePct(sectorMedian),
    notes: [
      "Base-rate evidence is bucketed from historical analog outcomes.",
      sectorHitRate != null
        ? "Sector-conditioned analog evidence is present for the current regime and valuation/RSI bucket."
        : "Sector-conditioned analog evidence is unavailable for this setup.",
    ],
  };
}

function deriveAggregateProbabilisticEvidence(
  baseRate: Record<string, unknown>,
  horizon: "60-day" | "252-day",
): ProbabilisticEvidenceView {
  const hitRate =
    horizon === "60-day"
      ? numberFrom(baseRate.h60_hit_rate)
      : numberFrom(baseRate.h252_hit_rate);
  // Prefer median over avg when available (Stage 2 SQL provides h60_median_pct)
  const outcome =
    numberFrom(baseRate.h60_median_pct) ??
    numberFrom(baseRate.h60_avg_pct);
  const p25 = numberFrom(baseRate.h60_p25_pct);
  const p75 = numberFrom(baseRate.h60_p75_pct);
  const sample =
    numberFrom(baseRate.n_observations) ??
    numberFrom(baseRate.n_with_h60) ??
    numberFrom(baseRate.n);

  // Derive state from sample_adequacy field when present (Stage 2 SQL),
  // otherwise fall back to computing from sample count.
  const sampleAdequacyRaw = stringValue(baseRate.sample_adequacy);
  const computedAdequacy = sampleAdequacyRaw ?? bucketSampleAdequacy(sample);

  let state: ProbabilisticEvidenceView["state"];
  if (hitRate == null) {
    state = "unavailable";
  } else if (
    (computedAdequacy === "ADEQUATE" || computedAdequacy === "ROBUST") &&
    hitRate != null
  ) {
    state = "complete";
  } else if (computedAdequacy === "WEAK") {
    state = "partial";
  } else {
    // INSUFFICIENT or missing adequacy
    state = "unavailable";
  }

  return {
    viewSchemaVersion: PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION,
    state,
    horizon,
    referenceSet: "aggregate_base_rate",
    sampleSize: sample,
    hitRatePct: hitRate,
    medianReturnPct: outcome,
    p25ReturnPct: p25,
    p75ReturnPct: p75,
    sampleAdequacy: computedAdequacy,
    hitRateBucket: bucketHitRatePct(hitRate),
    medianOutcomeBucket: bucketMedianOutcomePct(outcome),
    notes: [
      "Aggregate base-rate evidence is available; lower-tail path details are not yet present in this Ask path.",
    ],
  };
}

function derivePathRisk(
  selfAnalog: Record<string, unknown>,
  sectorAnalog: Record<string, unknown>,
  fullResearchObject: Record<string, unknown> | undefined,
): PathRiskView {
  const selfPath = asRecord(selfAnalog.path_risk_base);
  const sectorPath = asRecord(sectorAnalog.path_risk_base);
  const pathBase = numberFrom(selfPath.n) != null ? selfPath : sectorPath;
  const pathSource = stringValue(pathBase.source);
  const hasPathBase =
    numberFrom(pathBase.n) != null &&
    typeof pathSource === "string" &&
    pathSource.startsWith("pg_daily_price_path");
  const validatedEvidence = deriveValidatedPathEvidence(fullResearchObject);

  if (hasPathBase) {
    const sampleSize = numberFrom(pathBase.n);
    const sampleAdequacy = stringValue(pathBase.sample_adequacy);
    const lossRate = numberFrom(pathBase.loss_rate_h60_pct);
    const severeLossRate = numberFrom(pathBase.severe_loss_rate_h60_pct);
    const adverseExcursion = numberFrom(pathBase.p25_adverse_excursion_pct);
    const maxDrawdown = numberFrom(pathBase.p25_max_drawdown_pct);
    const p10MaxDrawdownPct = numberFrom(pathBase.p10_max_drawdown_pct);
    const worstMaxDrawdownPct = numberFrom(pathBase.worst_max_drawdown_pct);
    const hasNumericDrawdown =
      p10MaxDrawdownPct != null ||
      worstMaxDrawdownPct != null ||
      numberFrom(pathBase.prob_drawdown_gt_5_pct) != null ||
      numberFrom(pathBase.prob_drawdown_gt_10_pct) != null ||
      numberFrom(pathBase.prob_drawdown_gt_15_pct) != null ||
      numberFrom(pathBase.prob_drawdown_gt_20_pct) != null;
    const recoveryDays = numberFrom(pathBase.median_recovery_days);
    const warnings = [
      sampleAdequacy === "INSUFFICIENT"
        ? "Daily path-risk sample is insufficient; numeric drawdown fields are directional only."
        : undefined,
      !hasNumericDrawdown
        ? "Daily path rows were present, but numeric drawdown distribution fields were unavailable."
        : undefined,
    ].filter((item): item is string => !!item);
    return {
      viewSchemaVersion: PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION,
      state: sampleAdequacy === "INSUFFICIENT" || !hasNumericDrawdown ? "partial" : "complete",
      horizon: "60-day",
      source: "pg_daily_price_path",
      sampleSize,
      observedPathCount: sampleSize,
      sampleAdequacy,
      p10MaxDrawdownPct,
      worstMaxDrawdownPct,
      probDrawdownGt5Pct: numberFrom(pathBase.prob_drawdown_gt_5_pct),
      probDrawdownGt10Pct: numberFrom(pathBase.prob_drawdown_gt_10_pct),
      probDrawdownGt15Pct: numberFrom(pathBase.prob_drawdown_gt_15_pct),
      probDrawdownGt20Pct: numberFrom(pathBase.prob_drawdown_gt_20_pct),
      recoveredByHorizonRatePct: numberFrom(pathBase.recovered_by_horizon_rate_pct),
      lossProbabilityBucket: bucketLossRatePct(lossRate),
      severeLossProbabilityBucket: bucketLossRatePct(severeLossRate),
      downsideTailBucket: bucketTailOutcomePct(adverseExcursion),
      adverseExcursionBucket: bucketTailOutcomePct(adverseExcursion),
      maxDrawdownBucket: bucketTailOutcomePct(maxDrawdown),
      recoveryProfile: bucketRecoveryDays(recoveryDays),
      validatedEvidence,
      warnings,
      notes: [
        "Base-rate path risk is computed from PG daily price paths over the analog reference set.",
        "Validated overlay is separate: edge-specific path risk, Sentinel realized drawdown, and Coroner decay state.",
      ],
    };
  }

  const hitRate =
    numberFrom(selfAnalog.h60_hit_rate) ??
    numberFrom(sectorAnalog.h60_hit_rate);
  const p25 =
    numberFrom(selfAnalog.h60_p25_pct) ??
    numberFrom(sectorAnalog.h60_p25_pct);

  return {
    viewSchemaVersion: PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION,
    state: hitRate == null && p25 == null ? "unavailable" : "partial",
    horizon: "60-day",
    source: hitRate == null && p25 == null ? "unavailable" : "analog_return_distribution",
    lossProbabilityBucket: bucketLossProbabilityPct(hitRate),
    downsideTailBucket: bucketTailOutcomePct(p25),
    validatedEvidence,
    warnings: [
      hitRate == null && p25 == null
        ? "Daily price-path base-rate metrics and analog return fallback are unavailable."
        : "Numeric drawdown distribution is unavailable because daily price-path metrics are missing.",
    ],
    notes: [
      "Daily price-path base-rate metrics are unavailable; using lower-quartile analog returns as a fallback.",
      "Validated overlay is separate: edge-specific path risk, Sentinel realized drawdown, and Coroner decay state.",
    ],
  };
}

function deriveAggregatePathRisk(
  baseRate: Record<string, unknown>,
): PathRiskView {
  const hitRate = numberFrom(baseRate.h60_hit_rate);
  return {
    viewSchemaVersion: PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION,
    state: hitRate == null ? "unavailable" : "partial",
    horizon: "60-day",
    source: hitRate == null ? "unavailable" : "analog_return_distribution",
    lossProbabilityBucket: bucketLossProbabilityPct(hitRate),
    validatedEvidence: {
      edgeSpecificPathRisk: "unavailable",
      sentinelRealizedDrawdown: "unavailable",
      coronerDecay: "unavailable",
    },
    warnings: [
      "Numeric drawdown distribution is unavailable for aggregate anchors in this Ask path.",
    ],
    notes: [
      "Aggregate path risk has base-rate loss probability only; daily path metrics are not available for this aggregate anchor yet.",
    ],
  };
}


function deriveSectorPathRisk(
  researchObject: Record<string, unknown>,
): PathRiskView {
  const pathBase = asRecord(researchObject.path_risk_base);
  const hasPathBase = numberFrom(pathBase.n) != null;

  if (hasPathBase) {
    const sampleSize = numberFrom(pathBase.n);
    const sampleAdequacy = stringValue(pathBase.sample_adequacy);
    const lossRate = numberFrom(pathBase.loss_rate_h60_pct);
    const severeLossRate = numberFrom(pathBase.severe_loss_rate_h60_pct);
    const p10MaxDrawdownPct = numberFrom(pathBase.p10_max_drawdown_pct);
    const p25MaxDrawdownPct = numberFrom(pathBase.p25_max_drawdown_pct);
    const worstMaxDrawdownPct = numberFrom(pathBase.worst_max_drawdown_pct);
    const probDrawdownGt5Pct = numberFrom(pathBase.prob_drawdown_gt_5_pct);
    const probDrawdownGt10Pct = numberFrom(pathBase.prob_drawdown_gt_10_pct);
    const probDrawdownGt15Pct = numberFrom(pathBase.prob_drawdown_gt_15_pct);
    const probDrawdownGt20Pct = numberFrom(pathBase.prob_drawdown_gt_20_pct);
    const recoveryDays = numberFrom(pathBase.median_recovery_days);
    const recoveredByHorizonRatePct = numberFrom(pathBase.recovered_by_horizon_rate_pct);
    const hasNumericDrawdown =
      p10MaxDrawdownPct != null ||
      worstMaxDrawdownPct != null ||
      probDrawdownGt5Pct != null ||
      probDrawdownGt10Pct != null ||
      probDrawdownGt15Pct != null ||
      probDrawdownGt20Pct != null;
    const warnings = [
      sampleAdequacy === "INSUFFICIENT"
        ? "Daily path-risk sample is insufficient; numeric drawdown fields are directional only."
        : undefined,
      !hasNumericDrawdown
        ? "Daily path rows were present, but numeric drawdown distribution fields were unavailable."
        : undefined,
    ].filter((item): item is string => !!item);
    return {
      viewSchemaVersion: PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION,
      state: sampleAdequacy === "INSUFFICIENT" || !hasNumericDrawdown ? "partial" : "complete",
      horizon: "60-day",
      source: "pg_daily_price_path",
      sampleSize,
      observedPathCount: sampleSize,
      sampleAdequacy: sampleAdequacy ?? undefined,
      p10MaxDrawdownPct,
      worstMaxDrawdownPct,
      probDrawdownGt5Pct,
      probDrawdownGt10Pct,
      probDrawdownGt15Pct,
      probDrawdownGt20Pct,
      recoveredByHorizonRatePct,
      lossProbabilityBucket: bucketLossRatePct(lossRate),
      severeLossProbabilityBucket: bucketLossRatePct(severeLossRate),
      downsideTailBucket: bucketTailOutcomePct(p25MaxDrawdownPct),
      adverseExcursionBucket: bucketTailOutcomePct(p25MaxDrawdownPct),
      maxDrawdownBucket: bucketTailOutcomePct(p25MaxDrawdownPct),
      recoveryProfile: bucketRecoveryDays(recoveryDays),
      validatedEvidence: {
        edgeSpecificPathRisk: "unavailable",
        sentinelRealizedDrawdown: "unavailable",
        coronerDecay: "unavailable",
      },
      warnings,
      notes: [
        "Sector path risk is computed from daily price paths of all current sector constituents over a 60-day horizon.",
      ],
    };
  }

  const historicalBaseRate = asRecord(researchObject.historical_base_rate);
  const hitRate = numberFrom(historicalBaseRate.h60_hit_rate);
  return {
    viewSchemaVersion: PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION,
    state: hitRate == null ? "unavailable" : "partial",
    horizon: "60-day",
    source: hitRate == null ? "unavailable" : "analog_return_distribution",
    lossProbabilityBucket: bucketLossProbabilityPct(hitRate),
    validatedEvidence: {
      edgeSpecificPathRisk: "unavailable",
      sentinelRealizedDrawdown: "unavailable",
      coronerDecay: "unavailable",
    },
    warnings: [
      "Numeric drawdown distribution is unavailable for aggregate anchors in this Ask path.",
    ],
    notes: [
      "Aggregate sector path risk has base-rate loss probability only; daily path metrics are not available for this anchor yet.",
    ],
  };
}

function deriveRegimePathRisk(
  researchObject: Record<string, unknown>,
): PathRiskView {
  const pathBase = asRecord(researchObject.path_risk_base);
  const hasPathBase = numberFrom(pathBase.n) != null;

  if (hasPathBase) {
    const sampleSize = numberFrom(pathBase.n);
    const sampleAdequacy = stringValue(pathBase.sample_adequacy);
    const lossRate = numberFrom(pathBase.loss_rate_h60_pct);
    const severeLossRate = numberFrom(pathBase.severe_loss_rate_h60_pct);
    const p10MaxDrawdownPct = numberFrom(pathBase.p10_max_drawdown_pct);
    const p25MaxDrawdownPct = numberFrom(pathBase.p25_max_drawdown_pct);
    const worstMaxDrawdownPct = numberFrom(pathBase.worst_max_drawdown_pct);
    const probDrawdownGt5Pct = numberFrom(pathBase.prob_drawdown_gt_5_pct);
    const probDrawdownGt10Pct = numberFrom(pathBase.prob_drawdown_gt_10_pct);
    const probDrawdownGt15Pct = numberFrom(pathBase.prob_drawdown_gt_15_pct);
    const probDrawdownGt20Pct = numberFrom(pathBase.prob_drawdown_gt_20_pct);
    const recoveryDays = numberFrom(pathBase.median_recovery_days);
    const recoveredByHorizonRatePct = numberFrom(pathBase.recovered_by_horizon_rate_pct);
    const hasNumericDrawdown =
      p10MaxDrawdownPct != null ||
      worstMaxDrawdownPct != null ||
      probDrawdownGt5Pct != null ||
      probDrawdownGt10Pct != null ||
      probDrawdownGt15Pct != null ||
      probDrawdownGt20Pct != null;
    const warnings = [
      sampleAdequacy === "INSUFFICIENT"
        ? "Daily path-risk sample is insufficient; numeric drawdown fields are directional only."
        : undefined,
      !hasNumericDrawdown
        ? "Daily path rows were present, but numeric drawdown distribution fields were unavailable."
        : undefined,
    ].filter((item): item is string => !!item);
    return {
      viewSchemaVersion: PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION,
      state: sampleAdequacy === "INSUFFICIENT" || !hasNumericDrawdown ? "partial" : "complete",
      horizon: "60-day",
      source: "pg_daily_price_path",
      sampleSize,
      observedPathCount: sampleSize,
      sampleAdequacy: sampleAdequacy ?? undefined,
      p10MaxDrawdownPct,
      worstMaxDrawdownPct,
      probDrawdownGt5Pct,
      probDrawdownGt10Pct,
      probDrawdownGt15Pct,
      probDrawdownGt20Pct,
      recoveredByHorizonRatePct,
      lossProbabilityBucket: bucketLossRatePct(lossRate),
      severeLossProbabilityBucket: bucketLossRatePct(severeLossRate),
      downsideTailBucket: bucketTailOutcomePct(p25MaxDrawdownPct),
      adverseExcursionBucket: bucketTailOutcomePct(p25MaxDrawdownPct),
      maxDrawdownBucket: bucketTailOutcomePct(p25MaxDrawdownPct),
      recoveryProfile: bucketRecoveryDays(recoveryDays),
      validatedEvidence: {
        edgeSpecificPathRisk: "unavailable",
        sentinelRealizedDrawdown: "unavailable",
        coronerDecay: "unavailable",
      },
      warnings,
      notes: [
        "Regime path risk is computed from daily price paths of all constituents in the current market regime over a 60-day horizon.",
      ],
    };
  }

  const historicalBaseRate = asRecord(researchObject.historical_base_rate);
  const hitRate = numberFrom(historicalBaseRate.h60_hit_rate);
  return {
    viewSchemaVersion: PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION,
    state: hitRate == null ? "unavailable" : "partial",
    horizon: "60-day",
    source: hitRate == null ? "unavailable" : "analog_return_distribution",
    lossProbabilityBucket: bucketLossProbabilityPct(hitRate),
    validatedEvidence: {
      edgeSpecificPathRisk: "unavailable",
      sentinelRealizedDrawdown: "unavailable",
      coronerDecay: "unavailable",
    },
    warnings: [
      "Numeric drawdown distribution is unavailable for aggregate anchors in this Ask path.",
    ],
    notes: [
      "Aggregate regime path risk has base-rate loss probability only; daily path metrics are not available for this anchor yet.",
    ],
  };
}

function deriveValidatedPathEvidence(
  fullResearchObject: Record<string, unknown> | undefined,
): PathRiskView["validatedEvidence"] {
  const explicitPathRisk = asRecord(fullResearchObject?.path_risk);
  const edge = asRecord(fullResearchObject?.edge_evidence);
  const claims = Array.isArray(edge.claims) ? edge.claims.filter(isRecord) : [];
  const claimText = claims
    .map((claim) => `${stringValue(claim.derivation) ?? ""} ${stringValue(claim.text) ?? ""}`)
    .join(" ");
  return {
    edgeSpecificPathRisk: Object.keys(explicitPathRisk).length ? "complete" : "unavailable",
    sentinelRealizedDrawdown: /sentinel|realized|drawdown/i.test(claimText)
      ? "complete"
      : "unavailable",
    coronerDecay: /coroner|decay/i.test(claimText) ? "complete" : "unavailable",
  };
}

function buildStockWhatMattersNow(summary: Record<string, unknown>): string[] {
  const signals = Array.isArray(summary.activeSignals)
    ? summary.activeSignals.filter(isRecord)
    : [];
  const lines = signals
    .map((signal) => stringValue(signal.evidenceLanguage))
    .filter((line): line is string => !!line)
    .slice(0, 4);
  const fundamentals = asRecord(summary.fundamentalsSnapshot);
  const growth = stringValue(fundamentals.growthProfile);
  const quality = stringValue(fundamentals.financialQualityBand);
  const balance = stringValue(fundamentals.balanceSheetBand);
  if (growth || quality || balance) {
    lines.push(
      `Fundamental profile: growth ${growth ?? "unknown"}, quality ${quality ?? "unknown"}, balance sheet ${balance ?? "unknown"}.`,
    );
  }
  const regimeFit = stringValue(summary.regimeFit);
  if (regimeFit) lines.push(`Current regime fit is ${regimeFit}.`);
  return lines;
}

function buildSectorWhatMattersNow(summary: Record<string, unknown>): string[] {
  const lines: string[] = [
    numberFrom(summary.symbolsCovered) != null
      ? `${numberFrom(summary.symbolsCovered)} symbols are represented in the sector evidence set.`
      : undefined,
    stringValue(summary.currentRegimeBucket)
      ? `Current-regime historical hit-rate is bucketed ${stringValue(summary.currentRegimeBucket)}.`
      : undefined,
    stringValue(summary.sampleAdequacy)
      ? `Sample adequacy is ${stringValue(summary.sampleAdequacy)}.`
      : undefined,
  ].filter((item): item is string => !!item);

  // Add active signals evidence language (up to 2)
  const activeSignals = Array.isArray(summary.activeSignals)
    ? (summary.activeSignals as ActiveSignal[])
        .map((s) => s.evidenceLanguage)
        .filter((lang): lang is string => !!lang)
        .slice(0, 2)
    : [];
  lines.push(...activeSignals);

  return lines;
}

function buildRegimeWhatMattersNow(summary: Record<string, unknown>): string[] {
  return [
    stringValue(summary.regime)
      ? `Regime anchor is ${stringValue(summary.regime)}.`
      : undefined,
    stringValue(summary.unconditionalHitRateBucket)
      ? `Unconditional hit-rate bucket is ${stringValue(summary.unconditionalHitRateBucket)}.`
      : undefined,
    Array.isArray(summary.topSectorsTodayRank) &&
    summary.topSectorsTodayRank.length
      ? `Today's leading sectors: ${summary.topSectorsTodayRank.slice(0, 3).join(", ")}.`
      : undefined,
  ].filter((item): item is string => !!item);
}

function buildHistoricalAnalogBullets(
  probabilisticEvidence: ProbabilisticEvidenceView,
  label: string,
): string[] {
  const lines: string[] = [];
  if (probabilisticEvidence.hitRateBucket) {
    lines.push(
      `${label}: hit-rate bucket ${probabilisticEvidence.hitRateBucket}.`,
    );
  }
  if (probabilisticEvidence.medianOutcomeBucket) {
    lines.push(
      `${label}: median outcome bucket ${probabilisticEvidence.medianOutcomeBucket}.`,
    );
  }
  if (probabilisticEvidence.downsideQuartileBucket) {
    lines.push(
      `${label}: downside quartile bucket ${probabilisticEvidence.downsideQuartileBucket}.`,
    );
  }
  if (!lines.length) lines.push(`${label}: unavailable.`);
  return lines;
}

function buildStockConditionBullets(
  sectorAggregates: Record<string, unknown>,
): string[] {
  const analog = asRecord(sectorAggregates.analog_evidence_sector);
  const bucket = asRecord(analog.bucket_key);
  const conditions = [
    stringValue(bucket.regime),
    numberFrom(bucket.pe_bin) == null ? undefined : `P/E bin ${numberFrom(bucket.pe_bin)}`,
    numberFrom(bucket.rsi_bin) == null ? undefined : `RSI bin ${numberFrom(bucket.rsi_bin)}`,
    stringValue(bucket.valuation_bucket),
  ].filter((item): item is string => !!item);
  return conditions.length ? [`Conditioned analog bucket: ${conditions.join(" + ")}.`] : [];
}

function prefixList(prefix: string, values: string[]): string[] {
  return values.map((value) => `${prefix}: ${value}.`);
}

function prefixSectorBuckets(prefix: string, value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => {
      const sector = stringValue(item.sector);
      const bucket = stringValue(item.bucket);
      if (!sector) return undefined;
      return `${prefix}: ${sector}${bucket ? ` (${bucket})` : ""}.`;
    })
    .filter((item): item is string => !!item);
}

function unavailableEdgeEvidence(warning: string): EdgeEvidenceView {
  return {
    state: "unavailable",
    source: "unavailable",
    claims: [],
    rollingForwardValidation: [],
    warnings: [warning],
  };
}

// Bucket helpers — keep raw stats internal; never leak numbers into public projection.
function bucketHitRatePct(value: number | undefined): string | undefined {
  if (value == null) return undefined;
  if (value >= 60) return "STRONG";
  if (value >= 52) return "CONSTRUCTIVE";
  if (value >= 45) return "MIXED";
  return "WEAK";
}

function bucketMedianOutcomePct(value: number | undefined): string | undefined {
  if (value == null) return undefined;
  if (value >= 5) return "CONSTRUCTIVE";
  if (value >= 0) return "MIXED";
  return "WEAK";
}

function bucketTailOutcomePct(value: number | undefined): string | undefined {
  if (value == null) return undefined;
  if (value >= 5) return "CONSTRUCTIVE";
  if (value >= 0) return "MIXED_POSITIVE";
  if (value >= -5) return "MODERATE_DOWNSIDE";
  if (value >= -12) return "ELEVATED_DOWNSIDE";
  return "SEVERE_DOWNSIDE";
}

function bucketLossProbabilityPct(hitRatePct: number | undefined): string | undefined {
  if (hitRatePct == null) return undefined;
  const lossRate = 100 - hitRatePct;
  return bucketLossRatePct(lossRate);
}

function bucketLossRatePct(lossRatePct: number | undefined): string | undefined {
  if (lossRatePct == null) return undefined;
  if (lossRatePct <= 35) return "LOW";
  if (lossRatePct <= 48) return "MODERATE";
  if (lossRatePct <= 55) return "ELEVATED";
  return "HIGH";
}

function bucketRecoveryDays(days: number | undefined): string | undefined {
  if (days == null) return undefined;
  if (days <= 10) return "FAST";
  if (days <= 30) return "MODERATE";
  if (days <= 60) return "SLOW";
  return "UNRECOVERED_WITHIN_WINDOW";
}

function bucketConvergenceCount(value: number): string {
  if (value >= 5) return "MANY_FAMILIES";
  if (value >= 3) return "SEVERAL_FAMILIES";
  if (value >= 1) return "LIMITED_FAMILIES";
  return "NO_CONVERGENCE";
}

function bucketPercentileRank(value: number | undefined): string | undefined {
  if (value == null) return undefined;
  if (value >= 75) return "TOP_QUARTILE";
  if (value >= 50) return "ABOVE_MEDIAN";
  if (value >= 25) return "BELOW_MEDIAN";
  return "BOTTOM_QUARTILE";
}

function deriveRegimeFit(regimeContext: Record<string, unknown>): string | undefined {
  const current = stringValue(regimeContext.current_regime);
  const arr = Array.isArray(regimeContext.own_stock_by_regime)
    ? regimeContext.own_stock_by_regime.filter(isRecord)
    : [];
  if (!current || arr.length === 0) return undefined;
  const here = arr.find((row) => stringValue(row.regime) === current);
  const others = arr.filter((row) => stringValue(row.regime) !== current);
  const hereRate = numberFrom(here?.hit_rate_h60);
  const hereSample = numberFrom(here?.n) ?? 0;
  if (hereRate == null || hereSample < 30) return "UNCERTAIN";
  const otherRates = others.map((row) => numberFrom(row.hit_rate_h60)).filter((n): n is number => n != null);
  if (otherRates.length === 0) return "UNCERTAIN";
  const otherAvg = otherRates.reduce((a, b) => a + b, 0) / otherRates.length;
  if (hereRate >= otherAvg - 3) return "ALIGNED";
  return "CHALLENGED";
}

function deriveForwardPerformance(analogSelf: Record<string, unknown>): Record<string, unknown> | undefined {
  const sample = numberFrom(analogSelf.n);
  if (sample == null || sample === 0) return undefined;
  return {
    sampleAdequacy: stringValue(analogSelf.sample_adequacy),
    forwardWrBucket: bucketHitRatePct(numberFrom(analogSelf.h60_hit_rate)),
    forwardOutcomeBucket: bucketMedianOutcomePct(numberFrom(analogSelf.h60_median_pct)),
    horizon: "60-day",
    disclaimer: "Bucketed historical-analog evidence. Not investment advice.",
  };
}

// ─── NEW: deriveSectorForwardPerformance ──────────────────────────────────────
// Uses h60_p25_pct / h60_median_pct / h60_p75_pct from historical_base_rate
// (Stage 2 SQL). Falls back to h60_avg_pct when median is absent.
function deriveSectorForwardPerformance(
  baseRate: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const sample =
    numberFrom(baseRate.n_observations) ??
    numberFrom(baseRate.n_with_h60) ??
    numberFrom(baseRate.n);
  if (sample == null || sample === 0) return undefined;

  const hitRate = numberFrom(baseRate.h60_hit_rate);
  const median =
    numberFrom(baseRate.h60_median_pct) ??
    numberFrom(baseRate.h60_avg_pct);
  const p25 = numberFrom(baseRate.h60_p25_pct);
  const p75 = numberFrom(baseRate.h60_p75_pct);

  const sampleAdequacyRaw = stringValue(baseRate.sample_adequacy);
  const sampleAdequacy = sampleAdequacyRaw ?? bucketSampleAdequacy(sample);

  return {
    sampleAdequacy,
    forwardWrBucket: bucketHitRatePct(hitRate),
    forwardOutcomeBucket: bucketMedianOutcomePct(median),
    downsideQuartileBucket: bucketTailOutcomePct(p25),
    upsideQuartileBucket: bucketTailOutcomePct(p75),
    horizon: "60-day",
    disclaimer: "Bucketed sector base-rate evidence. Not investment advice.",
  };
}

// ─── NEW: deriveSectorRegimeFit ───────────────────────────────────────────────
// Reads regime_rollup array from under_which_conditions.
// hit_rate > median + 5 → ALIGNED, < median - 5 → CHALLENGED, else NEUTRAL,
// regime not found → UNCERTAIN.
function deriveSectorRegimeFit(
  currentRegime: string | undefined,
  regimeRollup: Array<Record<string, unknown>>,
): string | undefined {
  if (!currentRegime || regimeRollup.length === 0) return undefined;

  const rates = regimeRollup
    .map((row) => numberFrom(row.hit_rate_h60))
    .filter((n): n is number => n != null);
  if (rates.length === 0) return "UNCERTAIN";

  const median = rates.slice().sort((a, b) => a - b)[Math.floor(rates.length / 2)];

  const currentRow = regimeRollup.find(
    (row) => stringValue(row.regime) === currentRegime,
  );
  if (!currentRow) return "UNCERTAIN";

  const currentRate = numberFrom(currentRow.hit_rate_h60);
  if (currentRate == null) return "UNCERTAIN";

  if (currentRate > median + 5) return "ALIGNED";
  if (currentRate < median - 5) return "CHALLENGED";
  return "NEUTRAL";
}

// ─── NEW: deriveSectorActiveSignals ──────────────────────────────────────────
// Emits 2-4 sector-appropriate signals from fields already present in the
// sector SQL output. Does not read per-company trajectory/quality/allocation.
function deriveSectorActiveSignals(
  row: Record<string, unknown>,
  currentRegime: string | undefined,
): ActiveSignal[] {
  const signals: ActiveSignal[] = [];

  const conditions = asRecord(row.under_which_conditions);
  const regimeRollup = Array.isArray(conditions.regime_rollup)
    ? conditions.regime_rollup.filter(isRecord)
    : [];
  const eventContext = asRecord(row.event_context);
  const earningsClusterBand = stringValue(eventContext.earnings_cluster_band);

  // Signal 1: current regime hit_rate_h60 > 60
  if (currentRegime) {
    const currentRow = regimeRollup.find(
      (r) => stringValue(r.regime) === currentRegime,
    );
    const currentRate = numberFrom(currentRow?.hit_rate_h60);
    if (currentRate != null && currentRate > 60) {
      signals.push({
        family: "Regime",
        signalStrength: "STRONG",
        evidenceLanguage: "Regime historically favorable for this sector.",
      });
    }
  }

  // Signal 2: earnings concentration
  if (earningsClusterBand === "CONCENTRATED") {
    signals.push({
      family: "Event",
      signalStrength: "STRONG",
      evidenceLanguage:
        "Earnings concentration: significant binary event risk within 2 weeks.",
    });
  }

  // Signal 3: current regime is the best-performing bucket for this sector
  if (currentRegime) {
    const bucketExtremes = asRecord(conditions.bucket_extremes);
    const bestH60 = Array.isArray(bucketExtremes.best_h60)
      ? bucketExtremes.best_h60.filter(isRecord)
      : [];
    if (
      bestH60.length > 0 &&
      stringValue(bestH60[0].regime) === currentRegime
    ) {
      signals.push({
        family: "Regime",
        signalStrength: "MODERATE",
        evidenceLanguage:
          "Sector in historically best-performing bucket for current regime.",
      });
    }
  }

  return signals;
}

// ─── NEW: deriveSectorInvalidationSignals ────────────────────────────────────
// Reads regime_rollup and event_context to produce up to 3 invalidation strings.
function deriveSectorInvalidationSignals(
  row: Record<string, unknown>,
  currentRegime: string | undefined,
): string[] {
  const signals: string[] = [];

  const conditions = asRecord(row.under_which_conditions);
  const regimeRollup = Array.isArray(conditions.regime_rollup)
    ? conditions.regime_rollup.filter(isRecord)
    : [];
  const eventContext = asRecord(row.event_context);
  const earningsClusterBand = stringValue(eventContext.earnings_cluster_band);

  if (currentRegime) {
    const currentRow = regimeRollup.find(
      (r) => stringValue(r.regime) === currentRegime,
    );
    const currentRate = numberFrom(currentRow?.hit_rate_h60);
    const currentAvg = numberFrom(currentRow?.avg_h60_pct);

    // Signal 1: hit_rate < 45 → unfavorable regime
    if (currentRate != null && currentRate < 45) {
      signals.push(
        "Current regime historically unfavorable for this sector.",
      );
    }

    // Signal 3: negative expected return in current regime
    if (currentAvg != null && currentAvg < 0) {
      signals.push(
        "Negative expected return in current regime context.",
      );
    }
  }

  // Signal 2: earnings concentration creates binary reversal risk
  if (earningsClusterBand === "CONCENTRATED") {
    signals.push(
      "Earnings concentration creates binary reversal risk.",
    );
  }

  return signals;
}

// ─── NEW: deriveRegimeForwardPerformance ─────────────────────────────────────
// Same pattern as deriveSectorForwardPerformance — reads historical_base_rate
// from the regime SQL output. Uses h60_p25_pct / h60_median_pct / h60_p75_pct
// when present (Stage 2 regime SQL); falls back to h60_avg_pct when absent.
function deriveRegimeForwardPerformance(
  baseRate: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const sample =
    numberFrom(baseRate.n_observations) ??
    numberFrom(baseRate.n_with_h60) ??
    numberFrom(baseRate.n);
  if (sample == null || sample === 0) return undefined;

  const hitRate = numberFrom(baseRate.h60_hit_rate);
  const median =
    numberFrom(baseRate.h60_median_pct) ??
    numberFrom(baseRate.h60_avg_pct);
  const p25 = numberFrom(baseRate.h60_p25_pct);
  const p75 = numberFrom(baseRate.h60_p75_pct);

  const sampleAdequacyRaw = stringValue(baseRate.sample_adequacy);
  const sampleAdequacy = sampleAdequacyRaw ?? bucketSampleAdequacy(sample);

  return {
    sampleAdequacy,
    forwardWrBucket: bucketHitRatePct(hitRate),
    forwardOutcomeBucket: bucketMedianOutcomePct(median),
    downsideQuartileBucket: bucketTailOutcomePct(p25),
    upsideQuartileBucket: bucketTailOutcomePct(p75),
    horizon: "60-day",
    disclaimer: "Bucketed regime base-rate evidence. Not investment advice.",
  };
}

// ─── NEW: deriveRegimeActiveSignals ──────────────────────────────────────────
// Emits 0–2 regime-appropriate signals from sector_rollup and overall base rate.
// Signal 1: strong sector breadth (>3 sectors with hit_rate_h60 > 70).
// Signal 2: regime overall hit rate > 60 → positive for broad market.
function deriveRegimeActiveSignals(
  row: Record<string, unknown>,
): ActiveSignal[] {
  const signals: ActiveSignal[] = [];

  const conditions = asRecord(row.under_which_conditions);
  const sectorRollup = Array.isArray(conditions.sector_rollup)
    ? conditions.sector_rollup.filter(isRecord)
    : [];

  // Signal 1: sector breadth — count sectors with hit_rate_h60 > 70
  const strongSectors = sectorRollup.filter((r) => {
    const rate = numberFrom(r.hit_rate_h60);
    return rate != null && rate > 70;
  }).length;

  if (strongSectors > 3) {
    signals.push({
      family: "Regime",
      signalStrength: "STRONG",
      evidenceLanguage: "Strong sector breadth in this regime.",
    });
  }

  // Signal 2: overall regime hit rate > 60
  const historicalBaseRate = asRecord(row.historical_base_rate);
  const overallHitRate = numberFrom(historicalBaseRate.h60_hit_rate);
  if (overallHitRate != null && overallHitRate > 60) {
    signals.push({
      family: "Regime",
      signalStrength: "STRONG",
      evidenceLanguage: "Regime historically positive for broad market.",
    });
  }

  return signals;
}

// ─── NEW: deriveRegimeInvalidationSignals ────────────────────────────────────
// Reads sector_rollup and historical_base_rate to flag unfavorable regime signals.
// Signal 1: >50% sectors have hit_rate_h60 < 45 → majority underperform.
// Signal 2: overall h60_hit_rate < 45 → regime broadly unfavorable.
// Signal 3: h60_avg_pct < 0 → negative expected return.
function deriveRegimeInvalidationSignals(
  row: Record<string, unknown>,
): string[] {
  const signals: string[] = [];

  const conditions = asRecord(row.under_which_conditions);
  const sectorRollup = Array.isArray(conditions.sector_rollup)
    ? conditions.sector_rollup.filter(isRecord)
    : [];

  // Signal 1: majority of sectors historically underperform
  if (sectorRollup.length > 0) {
    const weakCount = sectorRollup.filter((r) => {
      const rate = numberFrom(r.hit_rate_h60);
      return rate != null && rate < 45;
    }).length;
    if (weakCount / sectorRollup.length > 0.5) {
      signals.push(
        "Majority of sectors historically underperform in this regime.",
      );
    }
  }

  const historicalBaseRate = asRecord(row.historical_base_rate);
  const overallHitRate = numberFrom(historicalBaseRate.h60_hit_rate);
  const overallAvg = numberFrom(historicalBaseRate.h60_avg_pct);

  // Signal 2: regime broadly unfavorable
  if (overallHitRate != null && overallHitRate < 45) {
    signals.push("Regime historically unfavorable for broad market.");
  }

  // Signal 3: negative expected forward return
  if (overallAvg != null && overallAvg < 0) {
    signals.push("Negative expected forward return in this regime.");
  }

  return signals;
}

// ─── NEW: deriveSectorUpcomingEvents ─────────────────────────────────────────
// Emits an event entry when earnings_cluster_band is CONCENTRATED or MODERATE.
function deriveSectorUpcomingEvents(
  row: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const eventContext = asRecord(row.event_context);
  const earningsClusterBand = stringValue(eventContext.earnings_cluster_band);
  const pctWithin2w = numberFrom(eventContext.pct_constituents_earnings_within_2w);

  if (earningsClusterBand === "CONCENTRATED" || earningsClusterBand === "MODERATE") {
    const event: Record<string, unknown> = {
      type: "SECTOR_EARNINGS_CLUSTER",
      windowBucket: earningsClusterBand,
    };
    if (pctWithin2w != null) {
      event.pctConstituentsWithin2w = pctWithin2w;
    }
    events.push(event);
  }

  return events;
}

type ActiveSignal = {
  family: string;
  signalStrength: "STRONG" | "MODERATE" | "WEAK";
  evidenceLanguage: string;
};

function deriveActiveSignals(input: {
  trajectory: Record<string, unknown>;
  growthCompound: Record<string, unknown>;
  financialQuality: Record<string, unknown>;
  capitalAllocation: Record<string, unknown>;
  forwardCatalysts: Record<string, unknown>;
  eventContext: Record<string, unknown>;
  companyState: Record<string, unknown>;
}): ActiveSignal[] {
  const signals: ActiveSignal[] = [];

  // Trajectory — beat/miss + revenue + margins + leverage trajectory
  const beats = numberFrom(asRecord(input.trajectory.beat_miss_pattern_8q).beats) ?? 0;
  const misses = numberFrom(asRecord(input.trajectory.beat_miss_pattern_8q).misses) ?? 0;
  const revenueDir = stringValue(input.trajectory.revenue_4q_vs_prior_4q);
  const marginDir = stringValue(input.trajectory.operating_margin_direction);
  const debtDir = stringValue(input.trajectory.debt_trajectory_4q);
  const trajPositives = [
    beats >= misses + 4,
    revenueDir === "ACCELERATING",
    marginDir === "EXPANDING",
    debtDir === "DELEVERAGING",
  ].filter(Boolean).length;
  if (trajPositives >= 3) {
    signals.push({
      family: "Trajectory",
      signalStrength: "STRONG",
      evidenceLanguage: trajectoryLanguage(beats, misses, revenueDir, marginDir, debtDir),
    });
  } else if (trajPositives === 2) {
    signals.push({
      family: "Trajectory",
      signalStrength: "MODERATE",
      evidenceLanguage: trajectoryLanguage(beats, misses, revenueDir, marginDir, debtDir),
    });
  }

  // Quality — Piotroski / income / fcf / cash conversion
  const piotroski = stringValue(asRecord(input.companyState.profitability).piotroski_band);
  const incomeQuality = stringValue(input.financialQuality.income_quality_band);
  const fcfEff = stringValue(input.financialQuality.fcf_ocf_efficiency_band);
  const cashConversion = stringValue(input.financialQuality.cash_conversion_cycle_band);
  const qualityPositives = [
    piotroski === "STRONG",
    incomeQuality === "HEALTHY",
    fcfEff === "HIGH",
    cashConversion === "NEGATIVE_FAVORABLE" || cashConversion === "FAVORABLE",
  ].filter(Boolean).length;
  if (qualityPositives >= 3) {
    signals.push({
      family: "Quality",
      signalStrength: "STRONG",
      evidenceLanguage:
        "Financial-quality bands are constructive: Piotroski strong, income healthy, FCF conversion high.",
    });
  } else if (qualityPositives === 2) {
    signals.push({
      family: "Quality",
      signalStrength: "MODERATE",
      evidenceLanguage: "Some financial-quality bands are constructive; not all are aligned.",
    });
  }

  // Capital allocation — buybacks / total return
  const buyback = stringValue(input.capitalAllocation.buyback_activity);
  const totalReturn = stringValue(input.capitalAllocation.total_return_to_shareholders_band);
  if (buyback === "AGGRESSIVE" && (totalReturn === "AT_OR_ABOVE_FCF" || totalReturn === "ABOVE_FCF")) {
    signals.push({
      family: "Capital Allocation",
      signalStrength: "STRONG",
      evidenceLanguage:
        "Aggressive buybacks with total shareholder return at-or-above free-cash-flow generation.",
    });
  } else if (buyback === "AGGRESSIVE" || buyback === "ACTIVE") {
    signals.push({
      family: "Capital Allocation",
      signalStrength: "MODERATE",
      evidenceLanguage: "Active capital return to shareholders via buybacks.",
    });
  }

  // Catalyst proximity — earnings window
  const earningsWindow =
    stringValue(input.forwardCatalysts.next_earnings_window) ??
    stringValue(input.eventContext.earnings_proximity);
  if (earningsWindow === "WITHIN_5_DAYS" || earningsWindow === "WITHIN_TWO_WEEKS") {
    signals.push({
      family: "Catalyst",
      signalStrength: earningsWindow === "WITHIN_5_DAYS" ? "STRONG" : "MODERATE",
      evidenceLanguage: `Near-term catalyst: earnings ${earningsWindow.toLowerCase().replace(/_/g, " ")}.`,
    });
  }

  return signals;
}

function trajectoryLanguage(
  beats: number,
  misses: number,
  revenueDir: string | undefined,
  marginDir: string | undefined,
  debtDir: string | undefined,
): string {
  const fragments: string[] = [];
  if (beats + misses > 0) fragments.push(`${beats}/${beats + misses} quarterly beats`);
  if (revenueDir === "ACCELERATING") fragments.push("revenue accelerating");
  if (marginDir === "EXPANDING") fragments.push("margins expanding");
  if (debtDir === "DELEVERAGING") fragments.push("deleveraging");
  return fragments.join(", ") + ".";
}

function deriveFundamentalsSnapshot(input: {
  liquidityTier: Record<string, unknown>;
  growthCompound: Record<string, unknown>;
  financialQuality: Record<string, unknown>;
  companyState: Record<string, unknown>;
  portfolio: Record<string, unknown>;
}): Record<string, unknown> {
  const growthBands = [
    stringValue(input.growthCompound.revenue_growth_1y_band),
    stringValue(input.growthCompound.eps_growth_1y_band),
    stringValue(input.growthCompound.fcf_growth_1y_band),
  ];
  const strong = growthBands.filter((b) => b === "STRONG" || b === "HIGH" || b === "GROWING").length;
  const growthProfile =
    strong >= 2 ? "STRONG" : strong === 1 ? "MODERATE" : "FLAT";

  const qualityBands = [
    stringValue(input.financialQuality.income_quality_band) === "HEALTHY",
    stringValue(input.financialQuality.fcf_ocf_efficiency_band) === "HIGH",
  ];
  const qualityPos = qualityBands.filter(Boolean).length;
  const financialQualityBand =
    qualityPos === 2 ? "HIGH" : qualityPos === 1 ? "MODERATE" : "MIXED";

  const altman = stringValue(asRecord(input.companyState.balance_sheet).altman_z_band);
  const leverage = stringValue(asRecord(input.companyState.balance_sheet).leverage_band);
  const balanceSheetBand =
    altman === "SAFE_ZONE" && (leverage === "LOW" || leverage === "MODERATE")
      ? "STRONG"
      : altman === "SAFE_ZONE"
      ? "ADEQUATE"
      : "STRESSED";

  return {
    marketCapTier: stringValue(input.liquidityTier.market_cap_tier),
    growthProfile,
    financialQualityBand,
    balanceSheetBand,
    peerRankPercentile: bucketPercentileRank(numberFrom(input.portfolio.composite_rank_in_sector)),
  };
}

function deriveUpcomingEvents(
  forwardCatalysts: Record<string, unknown>,
  eventContext: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const earnings =
    stringValue(forwardCatalysts.next_earnings_window) ??
    stringValue(eventContext.earnings_proximity);
  if (earnings && earnings !== "NONE_SCHEDULED") {
    events.push({ type: "EARNINGS", windowBucket: earnings });
  }
  const exdiv = stringValue(forwardCatalysts.next_exdiv_window);
  if (exdiv && exdiv !== "NONE_SCHEDULED") {
    events.push({ type: "EX_DIVIDEND", windowBucket: exdiv });
  }
  return events;
}

function deriveInvalidationSignals(input: {
  regimeContext: Record<string, unknown>;
  peerRelativePerf: Record<string, unknown>;
  forwardCatalysts: Record<string, unknown>;
  companyState: Record<string, unknown>;
  sectorInvalidation: Record<string, unknown>;
}): string[] {
  const signals: string[] = [];

  // Regime continuation risk — only flag when current regime hit-rate is below
  // the stock's own history under other regimes by a meaningful margin.
  const current = stringValue(input.regimeContext.current_regime);
  const arr = Array.isArray(input.regimeContext.own_stock_by_regime)
    ? input.regimeContext.own_stock_by_regime.filter(isRecord)
    : [];
  const here = arr.find((row) => stringValue(row.regime) === current);
  const others = arr.filter((row) => stringValue(row.regime) !== current);
  const hereRate = numberFrom(here?.hit_rate_h60);
  const otherRates = others.map((row) => numberFrom(row.hit_rate_h60)).filter((n): n is number => n != null);
  if (hereRate != null && otherRates.length > 0) {
    const otherAvg = otherRates.reduce((a, b) => a + b, 0) / otherRates.length;
    if (otherAvg - hereRate >= 5) {
      signals.push(
        `A regime shift would change the setup — historical h60 hit-rate is stronger outside the current ${current} regime.`,
      );
    }
  }

  // Sector underperformance widening
  const sector1m = stringValue(input.peerRelativePerf.vs_sector_1m);
  const sector12w = stringValue(input.peerRelativePerf.vs_sector_12w);
  if (sector1m === "UNDERPERFORM" || sector12w === "UNDERPERFORM") {
    signals.push("Sector-relative performance is currently UNDERPERFORM — watch for further widening.");
  }

  // Earnings outcome will materially update the trajectory signal
  const earnings =
    stringValue(input.forwardCatalysts.next_earnings_window) ??
    undefined;
  if (earnings === "WITHIN_5_DAYS" || earnings === "WITHIN_TWO_WEEKS") {
    signals.push(
      `Upcoming earnings (${earnings.toLowerCase().replace(/_/g, " ")}) will materially update the trajectory signal.`,
    );
  }

  // Balance-sheet stress
  const interestCov = stringValue(asRecord(input.companyState.balance_sheet).interest_coverage_band);
  if (interestCov === "STRESSED") {
    signals.push("Interest-coverage band is STRESSED — leverage tolerance narrows in a tighter-rate regime.");
  }

  return signals;
}

function buildSectorSummary(
  researchObject: Record<string, unknown>,
  snapshotSector: SectorLandscape["sectors"][number] | undefined,
): Record<string, unknown> {
  const meta = asRecord(researchObject.meta);
  const whyNow = asRecord(researchObject.why_now);
  const whatMatters = asRecord(researchObject.what_matters);
  const historicalBaseRate = asRecord(researchObject.historical_base_rate);
  const conditions = asRecord(researchObject.under_which_conditions);

  const sector = stringValue(meta.sector) ?? snapshotSector?.sector;
  const regime =
    stringValue(meta.current_market_regime) ??
    stringValue(whyNow.current_regime);

  const symbolsCovered = numberFrom(whatMatters.symbols);
  const industries = numberFrom(whatMatters.industries);
  const topLeaders = Array.isArray(whatMatters.top_leaders)
    ? whatMatters.top_leaders.filter(isRecord)
    : [];
  const bottomLaggards = Array.isArray(whatMatters.bottom_laggards)
    ? whatMatters.bottom_laggards.filter(isRecord)
    : [];

  const baseHitRate = numberFrom(historicalBaseRate.h60_hit_rate);
  const baseAvgPct = numberFrom(historicalBaseRate.h60_avg_pct);
  const baseSample = numberFrom(historicalBaseRate.n_observations);

  const regimeRollup = Array.isArray(conditions.regime_rollup)
    ? conditions.regime_rollup.filter(isRecord)
    : [];

  const regimeConditioning = deriveSectorRegimeConditioning(regime, regimeRollup);
  const favorableConditions = deriveSectorFavorableConditions(
    asRecord(conditions.bucket_extremes).best_h60,
  );
  const unfavorableConditions = deriveSectorFavorableConditions(
    asRecord(conditions.bucket_extremes).worst_h60,
  );

  // New derive* calls
  const forwardPerformance = deriveSectorForwardPerformance(historicalBaseRate);
  const regimeFit = deriveSectorRegimeFit(regime, regimeRollup);
  const activeSignals = deriveSectorActiveSignals(researchObject, regime);
  const invalidationSignals = deriveSectorInvalidationSignals(researchObject, regime);
  const upcomingEvents = deriveSectorUpcomingEvents(researchObject);

  return {
    sector,
    asOfDate: stringValue(meta.as_of_date),

    // Backdrop (bucketed)
    regime,
    vixBand: stringValue(whyNow.vix_band),
    sp500PerfBand: stringValue(whyNow.sp500_perf_4w_band),

    // Breadth — counts only, no named leaders or laggards
    symbolsCovered,
    industries,
    leaderCount: topLeaders.length,
    laggardCount: bottomLaggards.length,

    // Historical baseline (bucketed)
    unconditionalHitRateBucket: bucketHitRatePct(baseHitRate),
    unconditionalOutcomeBucket: bucketMedianOutcomePct(baseAvgPct),
    sampleAdequacy: bucketSampleAdequacy(baseSample),

    // Regime conditioning
    bestRegimeForSector: regimeConditioning.bestRegime,
    bestRegimeBucket: regimeConditioning.bestBucket,
    currentRegimeBucket: regimeConditioning.currentBucket,
    currentRegimeBelowBest: regimeConditioning.currentBelowBest,

    // Qualitative conditions — abstracted, no raw numbers
    favorableConditions,
    unfavorableConditions,

    // New derived fields
    forwardPerformance,
    regimeFit,
    activeSignals,
    invalidationSignals,
    upcomingEvents,

    // Backwards-compat fields used by the generic answer fallback path
    stocksInFocus: numberFrom(whatMatters.stocks_in_focus) ?? snapshotSector?.stocksInFocus,
    exampleSymbols: snapshotSector?.exampleSymbols ?? [],
    historicalEvidence: bucketSampleAdequacy(baseSample),

    whyNow: buildSectorWhyNow({
      sector,
      regime,
      vixBand: stringValue(whyNow.vix_band),
      sp500PerfBand: stringValue(whyNow.sp500_perf_4w_band),
      currentRegimeBucket: regimeConditioning.currentBucket,
    }),
  };
}

function bucketSampleAdequacy(n: number | undefined): string | undefined {
  if (n == null) return undefined;
  if (n >= 50000) return "ROBUST";
  if (n >= 5000) return "ADEQUATE";
  if (n >= 500) return "THIN";
  return "INSUFFICIENT";
}

function deriveSectorRegimeConditioning(
  currentRegime: string | undefined,
  regimeRollup: Array<Record<string, unknown>>,
): {
  bestRegime: string | undefined;
  bestBucket: string | undefined;
  currentBucket: string | undefined;
  currentBelowBest: boolean;
} {
  if (!regimeRollup.length) {
    return { bestRegime: undefined, bestBucket: undefined, currentBucket: undefined, currentBelowBest: false };
  }
  let best: { regime: string; rate: number } | undefined;
  let current: number | undefined;
  for (const row of regimeRollup) {
    const regime = stringValue(row.regime);
    const rate = numberFrom(row.hit_rate_h60);
    if (!regime || rate == null) continue;
    if (!best || rate > best.rate) best = { regime, rate };
    if (regime === currentRegime) current = rate;
  }
  return {
    bestRegime: best?.regime,
    bestBucket: bucketHitRatePct(best?.rate),
    currentBucket: bucketHitRatePct(current),
    currentBelowBest:
      best != null && current != null && best.rate - current >= 5,
  };
}

function deriveSectorFavorableConditions(value: unknown): string[] {
  // Abstract regime+bin combos to a short qualitative phrase per row.
  // We hide raw hit-rate / median percentages and only describe the conditions.
  if (!Array.isArray(value)) return [];
  const phrases = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const regime = stringValue(item.regime);
    const rsi = numberFrom(item.rsi_bin);
    const pe = numberFrom(item.pe_bin);
    const fragments: string[] = [];
    if (regime) fragments.push(regime);
    if (rsi != null) fragments.push(rsi <= 2 ? "low RSI" : rsi >= 4 ? "high RSI" : "mid RSI");
    if (pe != null) fragments.push(pe <= 2 ? "low P/E" : pe >= 4 ? "high P/E" : "mid P/E");
    if (fragments.length) phrases.add(fragments.join(" + "));
  }
  return Array.from(phrases).slice(0, 3);
}

function buildSectorWhyNow(input: {
  sector: string | undefined;
  regime: string | undefined;
  vixBand: string | undefined;
  sp500PerfBand: string | undefined;
  currentRegimeBucket: string | undefined;
}): string {
  const fragments: string[] = [];
  fragments.push(`${input.sector ?? "This sector"} backdrop`);
  if (input.regime) fragments.push(`under a ${input.regime} regime`);
  if (input.vixBand) fragments.push(`with ${input.vixBand} VIX band`);
  if (input.sp500PerfBand) {
    fragments.push(`and a 4-week SPX move bucketed ${input.sp500PerfBand.toLowerCase().replace(/_/g, " ")}`);
  }
  if (input.currentRegimeBucket) {
    fragments.push(`— historical h60 hit-rate in this regime is bucketed ${input.currentRegimeBucket}`);
  }
  return fragments.join(" ") + ".";
}

function buildRegimeSummary(
  researchObject: Record<string, unknown>,
  fallbackRegime: string,
): Record<string, unknown> {
  const meta = asRecord(researchObject.meta);
  const whyNow = asRecord(researchObject.why_now);
  const whatMatters = asRecord(researchObject.what_matters);
  const historicalBaseRate = asRecord(researchObject.historical_base_rate);
  const conditions = asRecord(researchObject.under_which_conditions);

  // Backwards-compat: older callers passed a flat shape with `regime.label`.
  // The current schema puts the label on `meta.regime` / `meta.current_market_regime`.
  const regimeLegacy = asRecord(researchObject.regime);
  const regime =
    stringValue(meta.regime) ??
    stringValue(meta.current_market_regime) ??
    stringValue(regimeLegacy.label) ??
    fallbackRegime;

  const baseHitRate = numberFrom(historicalBaseRate.h60_hit_rate);
  const baseOutcome = numberFrom(historicalBaseRate.h60_avg_pct);
  const baseLongHit = numberFrom(historicalBaseRate.h252_hit_rate);
  const baseSample = numberFrom(historicalBaseRate.n_observations);

  const sectorRollup = Array.isArray(conditions.sector_rollup)
    ? conditions.sector_rollup.filter(isRecord)
    : [];
  const { topSectors, bottomSectors } = rankSectorsByHitRate(sectorRollup);

  // Regime derive* calls
  const forwardPerformance = deriveRegimeForwardPerformance(historicalBaseRate);
  const activeSignals = deriveRegimeActiveSignals(researchObject);
  const invalidationSignals = deriveRegimeInvalidationSignals(researchObject);

  const sectorLeadership = Array.isArray(whatMatters.sector_leadership_today)
    ? whatMatters.sector_leadership_today.filter(isRecord)
    : [];
  const topSectorsToday = sectorLeadership
    .slice()
    .sort((a, b) => (numberFrom(a.rank_composite) ?? 99) - (numberFrom(b.rank_composite) ?? 99))
    .slice(0, 3)
    .map((row) => stringValue(row.sector))
    .filter((value): value is string => !!value);

  const topLeadersToday = Array.isArray(whatMatters.top_leaders_today)
    ? whatMatters.top_leaders_today.filter(isRecord)
    : [];

  return {
    regime,
    asOfDate: stringValue(meta.as_of_date),
    isCurrentRegime: meta.is_current_market_regime === true,

    // Backdrop bands (no raw VIX / yield numbers)
    vixBand: stringValue(whyNow.vix_band) ?? stringValue(regimeLegacy.vix_band),
    sp500PerfBand: stringValue(whyNow.sp500_perf_4w_band),
    tenYearYieldBand: stringValue(whyNow.ten_year_yield_band),

    // Historical baseline (bucketed)
    unconditionalHitRateBucket: bucketHitRatePct(baseHitRate),
    unconditionalOutcomeBucket: bucketMedianOutcomePct(baseOutcome),
    longHorizonHitRateBucket: bucketHitRatePct(baseLongHit),
    sampleAdequacy: bucketSampleAdequacy(baseSample),

    // Sector conditioning under this regime — bucketed, sector names only
    topSectorsHistorical: topSectors,       // [{ sector, bucket }]
    bottomSectorsHistorical: bottomSectors, // [{ sector, bucket }]

    // Today's leadership snapshot — sector names only, no symbols
    sectorsActiveToday: numberFrom(whatMatters.sectors_active_today),
    topSectorsTodayRank: topSectorsToday,
    leaderCount: topLeadersToday.length,

    // Regime derive* fields
    forwardPerformance,
    activeSignals,
    invalidationSignals,

    whyNow: buildRegimeWhyNow({
      regime,
      vixBand: stringValue(whyNow.vix_band),
      sp500PerfBand: stringValue(whyNow.sp500_perf_4w_band),
      tenYearYieldBand: stringValue(whyNow.ten_year_yield_band),
      hitRateBucket: bucketHitRatePct(baseHitRate),
    }),
  };
}

function rankSectorsByHitRate(rollup: Array<Record<string, unknown>>): {
  topSectors: Array<{ sector: string; bucket: string }>;
  bottomSectors: Array<{ sector: string; bucket: string }>;
} {
  const rows = rollup
    .map((row) => {
      const sector = stringValue(row.sector);
      const rate = numberFrom(row.hit_rate_h60);
      return sector && rate != null ? { sector, rate } : undefined;
    })
    .filter((value): value is { sector: string; rate: number } => !!value);
  if (!rows.length) return { topSectors: [], bottomSectors: [] };
  const sorted = rows.slice().sort((a, b) => b.rate - a.rate);
  const top = sorted.slice(0, 3).map(({ sector, rate }) => ({
    sector,
    bucket: bucketHitRatePct(rate) ?? "MIXED",
  }));
  const bottom = sorted
    .slice(-3)
    .reverse()
    .map(({ sector, rate }) => ({
      sector,
      bucket: bucketHitRatePct(rate) ?? "WEAK",
    }));
  return { topSectors: top, bottomSectors: bottom };
}

function buildRegimeWhyNow(input: {
  regime: string;
  vixBand: string | undefined;
  sp500PerfBand: string | undefined;
  tenYearYieldBand: string | undefined;
  hitRateBucket: string | undefined;
}): string {
  const fragments: string[] = [`The market is in a ${input.regime} regime`];
  const conditions: string[] = [];
  if (input.vixBand) conditions.push(`${input.vixBand} VIX`);
  if (input.sp500PerfBand) {
    conditions.push(`SPX 4w ${input.sp500PerfBand.toLowerCase().replace(/_/g, " ")}`);
  }
  if (input.tenYearYieldBand) conditions.push(`10y yield ${input.tenYearYieldBand}`);
  if (conditions.length) fragments.push(`with ${conditions.join(" · ")}`);
  if (input.hitRateBucket) {
    fragments.push(`— historical 60-day forward hit-rate in this regime is bucketed ${input.hitRateBucket}`);
  }
  return fragments.join(" ") + ".";
}

function buildWhyNowText(input: {
  symbol: string | undefined;
  regime: string | undefined;
  regimeFit: string | undefined;
  eventUrgency: string | undefined;
  topSignal: ActiveSignal | undefined;
}): string {
  const { symbol, regime, regimeFit, eventUrgency, topSignal } = input;
  const fragments: string[] = [];

  if (topSignal) {
    fragments.push(
      `${symbol ?? "This stock"} shows a ${topSignal.signalStrength.toLowerCase()} ${topSignal.family.toLowerCase()} setup`,
    );
  } else {
    fragments.push(`${symbol ?? "This stock"} has a current Research Object`);
  }

  if (regime) {
    const fitClause =
      regimeFit === "ALIGNED"
        ? `under a regime-aligned ${regime} backdrop`
        : regimeFit === "CHALLENGED"
        ? `against a regime-challenged ${regime} backdrop`
        : `under a ${regime} regime`;
    fragments.push(fitClause);
  }
  if (eventUrgency && eventUrgency !== "NONE_SCHEDULED") {
    fragments.push(`with a near-term catalyst (${eventUrgency.toLowerCase().replace(/_/g, " ")})`);
  }
  return fragments.join(" ") + ".";
}

/**
 * Resolve the current market-regime label so the regime Research Object can
 * be built unconditionally. Order of preference:
 *   1. Already-loaded research objects (stock/sector ROs carry the regime
 *      label inside their core data).
 *   2. The pipeline `get_market_context` tool output (snapshot fallback).
 *   3. A direct Postgres lookup against `md_historical_features_daily` for
 *      SPY's `market_regime` — the same table the regime SQL itself reads.
 *
 * The PG lookup is intentional: the snapshot is "supplemental" per project
 * direction; PG is canonical. A single one-row indexed lookup is cheap and
 * lets the regime RO load even when the classifier never set
 * `regimeRequested` and no stock context is in flight.
 */
async function resolveCurrentRegime(
  marketContext: MarketContext | undefined,
  objects: CachedResearchObject[],
): Promise<string | undefined> {
  for (const object of objects) {
    const regime = stringFrom(object.publicSummary.regime);
    if (regime) return regime;
  }
  if (marketContext?.regime) return marketContext.regime;
  if (!isResearchDbConfigured()) return undefined;
  try {
    const rows = await queryExternalReadonly<{ market_regime?: unknown }>(
      `SELECT market_regime
         FROM md_historical_features_daily
        WHERE symbol = 'SPY'
          AND is_delisted = false
        ORDER BY as_of_date DESC
        LIMIT 1`,
    );
    const value = stringValue(rows[0]?.market_regime);
    return value ? value.toUpperCase() : undefined;
  } catch (err) {
    logger.warn("Ask Grahamy resolveCurrentRegime PG fallback failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function researchObjectDate(freshness: FreshnessMetadata | undefined): string {
  return (
    freshness?.dataThrough ||
    freshness?.generatedAt?.slice(0, 10) ||
    new Date().toISOString().slice(0, 10)
  );
}

function isResearchDbConfigured(): boolean {
  return Boolean(process.env.EXTERNAL_PG_HOST && process.env.EXTERNAL_PG_DATABASE);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function eventRowsFromSummary(
  summary: Record<string, unknown>,
): StockResearchContext["symbols"][number]["notableEvents"] {
  const eventUrgency = stringFrom(summary.eventUrgency);
  return eventUrgency
    ? [{ eventType: "EARNINGS", impactBucket: eventUrgency }]
    : undefined;
}

function firstStringValue(
  object: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = stringValue(object[key]);
    if (value) return value;
  }
  return undefined;
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function sanitizeResearchPart(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeResearchPart);
  }
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith("_")) continue;
    const sanitized = sanitizeResearchPart(item);
    if (isRecord(sanitized) && Object.keys(sanitized).length === 0) continue;
    out[key] = sanitized;
  }
  return out;
}
