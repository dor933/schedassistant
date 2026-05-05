import type {
  CachedResearchObject,
  PublicResearchObjectView,
} from "../../types";

const generatedAt = "2026-05-01T14:00:00Z";

function baseView(input: {
  cacheKey: string;
  objectType: "stock" | "sector" | "regime";
  anchor: string;
  title: string;
}): PublicResearchObjectView {
  return {
    viewSchemaVersion: 2,
    cacheKey: input.cacheKey,
    objectType: input.objectType,
    anchor: input.anchor,
    asOfDate: "2026-05-01",
    title: input.title,
    fiveQuestion: {
      whatMattersNow: ["Current public evidence is available."],
      whyNow: "The latest public snapshot has an answerable setup.",
      historicalAnalogs: ["Historical analog evidence is available."],
      underWhichConditions: ["The setup needs public evidence to keep confirming."],
      invalidation: ["The setup weakens if the public evidence deteriorates."],
    },
    edgeEvidence: {
      state: "unavailable",
      source: "unavailable",
      claims: [],
      warnings: ["Validated live edge overlay is not included in this fixture."],
    },
    probabilisticEvidence: {
      viewSchemaVersion: 1,
      state: "complete",
      horizon: "60-day",
      referenceSet: "self_analogs",
      sampleSize: 125,
      hitRatePct: 61,
      medianReturnPct: 3.2,
      p25ReturnPct: -4.4,
      p75ReturnPct: 8.7,
      sampleAdequacy: "ROBUST",
      notes: ["Public numeric base-rate evidence is available."],
    },
    pathRisk: {
      viewSchemaVersion: 1,
      state: "complete",
      horizon: "60-day",
      source: "pg_daily_price_path",
      sampleSize: 125,
      observedPathCount: 125,
      sampleAdequacy: "ROBUST",
      p10MaxDrawdownPct: -14,
      worstMaxDrawdownPct: -31,
      probDrawdownGt5Pct: 32,
      probDrawdownGt10Pct: 18,
      probDrawdownGt15Pct: 8,
      probDrawdownGt20Pct: 3,
      recoveredByHorizonRatePct: 72,
      warnings: [],
      notes: ["Numeric path risk comes from daily price path evidence."],
    },
    freshness: {
      dataThrough: "2026-05-01",
      generatedAt,
    },
    warnings: [],
  };
}

function cachedObject(view: PublicResearchObjectView): CachedResearchObject {
  return {
    cacheKey: view.cacheKey,
    objectType: view.objectType,
    anchor: view.anchor,
    asOfDate: view.asOfDate,
    generatedAt,
    source: "database",
    publicSummary: {},
    parts: {},
    view,
    freshness: {
      dataThrough: view.asOfDate,
      generatedAt,
    },
    warnings: [],
  };
}

export const goldenStockResearchObject = cachedObject(
  baseView({
    cacheKey: "STOCK:GSL:2026-05-01",
    objectType: "stock",
    anchor: "GSL",
    title: "GSL public Research Object",
  }),
);

export const goldenSectorResearchObject = cachedObject(
  baseView({
    cacheKey: "SECTOR:Energy:2026-05-01",
    objectType: "sector",
    anchor: "Energy",
    title: "Energy public Research Object",
  }),
);

export const goldenRegimeResearchObject = cachedObject(
  baseView({
    cacheKey: "REGIME:MARKET:2026-05-01",
    objectType: "regime",
    anchor: "MARKET",
    title: "Market regime public Research Object",
  }),
);
