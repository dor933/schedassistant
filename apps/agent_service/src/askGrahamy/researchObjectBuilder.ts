import { logger } from "../logger";
import { isRecord, stringValue } from "./snapshotClient";
import { runResearchQuery } from "./researchQueryClient";
import {
  buildResearchObjectCacheKey,
  getCachedResearchObject,
  setCachedResearchObject,
} from "./researchObjectCache";
import type {
  CachedResearchObject,
  Classification,
  FreshnessMetadata,
  MarketContext,
  SectorLandscape,
  SnapshotBundle,
  StockResearchContext,
  ToolOutputs,
} from "./types";

export type ResearchObjectBuildResult = {
  objects: CachedResearchObject[];
  stats: { hits: number; misses: number; writes: number };
  warnings: string[];
};

export async function buildResearchObjects(input: {
  classification: Classification;
  snapshots: SnapshotBundle;
  toolOutputs: ToolOutputs;
}): Promise<ResearchObjectBuildResult> {
  const { classification, snapshots, toolOutputs } = input;
  const stats = { hits: 0, misses: 0, writes: 0 };
  const warnings: string[] = [];
  const objects: CachedResearchObject[] = [];

  if (!isResearchDbConfigured()) {
    return { objects, stats, warnings };
  }

  const asOfDate = researchObjectDate(snapshots.freshness);

  for (const symbol of classification.symbols) {
    const cacheKey = buildResearchObjectCacheKey("STOCK", symbol, asOfDate);
    const cached = await getCachedResearchObject<CachedResearchObject>(cacheKey);
    if (cached) {
      stats.hits += 1;
      objects.push({ ...cached.value, source: "redis" });
      continue;
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
      await setCachedResearchObject(cacheKey, stockObject);
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
    const cached = await getCachedResearchObject<CachedResearchObject>(cacheKey);
    if (cached) {
      stats.hits += 1;
      objects.push({ ...cached.value, source: "redis" });
      continue;
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
      await setCachedResearchObject(cacheKey, sectorObject);
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

  if (classification.regimeRequested) {
    const regime = inferRegime(toolOutputs.get_market_context, objects);
    if (regime) {
      const cacheKey = buildResearchObjectCacheKey("REGIME", "MARKET", asOfDate);
      const cached = await getCachedResearchObject<CachedResearchObject>(cacheKey);
      if (cached) {
        stats.hits += 1;
        objects.push({ ...cached.value, source: "redis" });
      } else {
        stats.misses += 1;
        try {
          const regimeObject = await buildRegimeResearchObject({
            regime,
            asOfDate,
            freshness: snapshots.freshness ?? {},
          });
          objects.push(regimeObject);
          await setCachedResearchObject(cacheKey, regimeObject);
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

  return { objects, stats, warnings };
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
  return {
    cacheKey,
    objectType: "stock",
    anchor: symbol,
    asOfDate: stringValue(asRecord(core.meta).as_of_date) ?? input.asOfDate,
    generatedAt: new Date().toISOString(),
    source: "database",
    publicSummary: buildStockSummary(core, sectorAggregates, quality, snapshotStock),
    parts: {
      core: sanitizeResearchPart(core),
      sectorAggregates: sanitizeResearchPart(sectorAggregates),
      financialQuality: sanitizeResearchPart(quality),
      snapshot: snapshotStock,
    },
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

  return {
    cacheKey: buildResearchObjectCacheKey("SECTOR", input.sector, input.asOfDate),
    objectType: "sector",
    anchor: input.sector,
    asOfDate: stringValue(asRecord(researchObject.meta).as_of_date) ?? input.asOfDate,
    generatedAt: new Date().toISOString(),
    source: "database",
    publicSummary: buildSectorSummary(researchObject, snapshotSector),
    parts: { sector: sanitizeResearchPart(researchObject), snapshot: snapshotSector },
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

  return {
    cacheKey: buildResearchObjectCacheKey("REGIME", "MARKET", input.asOfDate),
    objectType: "regime",
    anchor: "MARKET",
    asOfDate: stringValue(asRecord(researchObject.meta).as_of_date) ?? input.asOfDate,
    generatedAt: new Date().toISOString(),
    source: "database",
    publicSummary: buildRegimeSummary(researchObject, input.regime),
    parts: { regime: sanitizeResearchPart(researchObject) },
    freshness: input.freshness,
    warnings: [],
  };
}

function buildStockSummary(
  core: Record<string, unknown>,
  sectorAggregates: Record<string, unknown>,
  quality: Record<string, unknown>,
  snapshotStock: StockResearchContext["symbols"][number] | undefined,
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

    // Forward performance — bucketed only.
    forwardPerformance: forward,

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

function inferRegime(
  marketContext: MarketContext | undefined,
  objects: CachedResearchObject[],
): string | undefined {
  if (marketContext?.regime) return marketContext.regime;
  for (const object of objects) {
    const regime = stringFrom(object.publicSummary.regime);
    if (regime) return regime;
  }
  return undefined;
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
