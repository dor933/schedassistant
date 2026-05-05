import type {
  ComparisonView,
  FactorBacktestView,
  FeatureScreenView,
  PgCapabilityViews,
  RegimeHistoricalPlaybookView,
  SectorDeltaView,
  SectorDivergenceView,
  SectorLeaderboardView,
  StockIdeaView,
} from "../../types";

export const goldenSectorLeaderboardView: SectorLeaderboardView = {
  viewSchemaVersion: 1,
  state: "complete",
  source: "pg_sector_peer_daily",
  period: "latest",
  rankingBasis: "conviction",
  asOfDate: "2026-05-01",
  rows: [
    {
      sector: "Industrials",
      rank: 1,
      convictionScorePct: 82.4,
      convictionBucket: "HIGH",
      evidenceStrength: "ROBUST",
      hitRatePct: 58.2,
      momentumBucket: "MIXED",
    },
  ],
  freshness: { dataThrough: "2026-05-01", state: "fresh" },
  warnings: [],
};

export const goldenStockIdeaView: StockIdeaView = {
  viewSchemaVersion: 1,
  state: "partial",
  source: "pg_features_daily",
  asOfDate: "2026-05-01",
  rankingBasis: "setup_quality",
  rows: [
    {
      symbol: "GSL",
      companyName: "Global Ship Lease, Inc.",
      sector: "Industrials",
      rank: 1,
      convictionScorePct: 82.4,
      convictionBucket: "HIGH",
      evidenceStrength: "ROBUST",
      hitRatePct: 61.2,
      medianReturnPct: 5.24,
      valuationBucket: "ATTRACTIVE",
      qualityBucket: "CONSTRUCTIVE",
      momentumBucket: "STRONG",
      pathRiskBucket: "Numeric daily path-risk is unavailable in V1.",
      reasonBullets: ["Sector-relative conviction bucket is HIGH."],
    },
  ],
  freshness: { dataThrough: "2026-05-01", state: "fresh" },
  warnings: ["These are research candidates to review, not recommendations."],
};

export const goldenSectorDivergenceView: SectorDivergenceView = {
  viewSchemaVersion: 1,
  state: "complete",
  source: "pg_sector_peer_daily",
  period: "latest",
  asOfDate: "2026-05-01",
  evaluatedSectorCount: 11,
  clearDivergenceCount: 1,
  rows: [
    {
      sector: "Utilities",
      rank: 1,
      convictionScorePct: 70,
      convictionBucket: "CONSTRUCTIVE",
      momentumScorePct: 30,
      momentumBucket: "WEAK",
      divergenceType: "conviction_but_weak_price_action",
      hitRatePct: 58.2,
      evidenceStrength: "ADEQUATE",
      interpretationBullets: [
        "Conviction is constructive while price action is weak.",
      ],
    },
  ],
  freshness: { dataThrough: "2026-05-01", state: "fresh" },
  warnings: [],
};

export const goldenEmptySectorDivergenceView: SectorDivergenceView = {
  ...goldenSectorDivergenceView,
  rows: [],
  clearDivergenceCount: 0,
  warnings: [
    "No clear conviction-versus-momentum divergence was found in the latest view.",
  ],
};

export const goldenSectorDeltaView: SectorDeltaView = {
  viewSchemaVersion: 1,
  state: "complete",
  source: "pg_sector_weekly_history",
  period: "week_over_week",
  currentAsOfDate: "2026-04-27",
  priorAsOfDate: "2026-04-20",
  rankingBasis: "overall_change",
  rows: [
    {
      sector: "Technology",
      rank: 1,
      currentConvictionScorePct: 76,
      priorConvictionScorePct: 68,
      convictionDeltaPct: 8,
      currentConvictionBucket: "HIGH",
      priorConvictionBucket: "CONSTRUCTIVE",
      currentMomentumBucket: "STRONG",
      priorMomentumBucket: "MIXED",
      momentumDeltaPct: 5,
      direction: "improved",
      interpretationBullets: ["Weekly conviction proxy improved by 8 points."],
    },
  ],
  freshness: { dataThrough: "2026-04-27", state: "fresh" },
  warnings: [],
};

export const goldenStockVsSectorComparisonView: ComparisonView = {
  viewSchemaVersion: 1,
  state: "partial",
  comparisonType: "stock_vs_sector",
  source: "pg_current_features",
  asOfDate: "2026-05-01",
  left: {
    type: "stock",
    label: "GSL",
    symbol: "GSL",
    sector: "Industrials",
    metrics: {
      convictionScorePct: 82,
      convictionBucket: "HIGH",
      valuationBucket: "ATTRACTIVE",
      momentumBucket: "STRONG",
    },
  },
  right: {
    type: "sector",
    label: "Industrials",
    sector: "Industrials",
    metrics: {
      convictionScorePct: 55,
      convictionBucket: "MIXED",
      momentumBucket: "MIXED",
    },
  },
  deltas: [
    {
      metric: "conviction",
      leftValue: 82,
      rightValue: 55,
      delta: 27,
      interpretationBucket: "left_stronger",
      explanation: "Compares public conviction fields.",
    },
  ],
  summaryBullets: ["GSL screens stronger than Industrials on conviction."],
  freshness: { dataThrough: "2026-05-01", state: "fresh" },
  warnings: ["Daily path-risk comparison is unavailable in V1."],
};

export const goldenSectorVsSectorComparisonView: ComparisonView = {
  ...goldenStockVsSectorComparisonView,
  state: "complete",
  comparisonType: "sector_vs_sector",
  source: "pg_sector_peer_daily",
  left: {
    type: "sector",
    label: "Technology",
    sector: "Technology",
    metrics: { convictionScorePct: 72, convictionBucket: "CONSTRUCTIVE" },
  },
  right: {
    type: "sector",
    label: "Industrials",
    sector: "Industrials",
    metrics: { convictionScorePct: 52, convictionBucket: "MIXED" },
  },
  summaryBullets: ["Technology screens stronger than Industrials on conviction."],
  warnings: [],
};

export const goldenSymbolVsSymbolComparisonView: ComparisonView = {
  ...goldenStockVsSectorComparisonView,
  comparisonType: "symbol_vs_symbol",
  left: {
    type: "stock",
    label: "GSL",
    symbol: "GSL",
    sector: "Industrials",
    metrics: { convictionScorePct: 82, convictionBucket: "HIGH" },
  },
  right: {
    type: "stock",
    label: "DAC",
    symbol: "DAC",
    sector: "Industrials",
    metrics: { convictionScorePct: 58, convictionBucket: "MIXED" },
  },
  summaryBullets: ["GSL screens stronger than DAC on conviction."],
};

export const goldenUnavailableComparisonView: ComparisonView = {
  viewSchemaVersion: 1,
  state: "unavailable",
  comparisonType: "stock_vs_sector",
  source: "pg_current_features",
  left: { type: "stock", label: "FAKE123", symbol: "FAKE123", metrics: {} },
  right: { type: "sector", label: "Sector", sector: "Sector", metrics: {} },
  deltas: [],
  summaryBullets: [],
  freshness: { state: "unknown" },
  warnings: ["One or more comparison anchors were missing or invalid."],
};

export const goldenRegimeHistoricalPlaybookView: RegimeHistoricalPlaybookView = {
  viewSchemaVersion: 1,
  state: "complete",
  source: "pg_regime_history",
  regime: "NEUTRAL",
  asOfDate: "2026-05-04",
  rows: [
    {
      sector: "Industrials",
      rank: 1,
      role: "leader",
      hitRatePct: 56.2,
      evidenceStrength: "ROBUST",
      interpretationBullets: [
        "Industrials has historically screened among stronger sectors in NEUTRAL regimes.",
      ],
    },
  ],
  risks: [
    {
      riskLabel: "Volatility backdrop",
      riskBucket: "MODERATE",
      interpretation: "Volatility backdrop is moderate in the public bucket.",
    },
  ],
  summaryBullets: [
    "In NEUTRAL regimes, historical sector leaders in this view include Industrials.",
  ],
  freshness: { dataThrough: "2026-05-04", state: "fresh" },
  warnings: [],
};

export const goldenFeatureScreenView: FeatureScreenView = {
  viewSchemaVersion: 1,
  state: "complete",
  source: "pg_current_features",
  asOfDate: "2026-05-01",
  screenCriteria: [
    { factor: "valuation", bucket: "ATTRACTIVE" },
    { factor: "quality", bucket: "STRONG" },
  ],
  rows: [
    {
      symbol: "GSL",
      companyName: "Global Ship Lease, Inc.",
      sector: "Industrials",
      rank: 1,
      valuationBucket: "ATTRACTIVE",
      qualityBucket: "STRONG",
      momentumBucket: "STRONG",
      convictionBucket: "HIGH",
      reasonBullets: ["Valuation and quality buckets matched the screen."],
    },
  ],
  freshness: { dataThrough: "2026-05-01", state: "fresh" },
  warnings: ["These are screen results to review, not recommendations."],
};

export const goldenEmptyFeatureScreenView: FeatureScreenView = {
  ...goldenFeatureScreenView,
  rows: [],
  warnings: ["No matching candidates were found for the public screen criteria."],
};

export const goldenFactorBacktestView: FactorBacktestView = {
  viewSchemaVersion: 1,
  state: "complete",
  source: "pg_factor_history",
  horizon: "60-day",
  criteria: [
    { factor: "momentum", bucket: "WEAK" },
    { factor: "valuation", bucket: "ATTRACTIVE" },
  ],
  sampleSize: 7403,
  hitRatePct: 36,
  medianReturnPct: -4.39,
  p25ReturnPct: -13.98,
  p75ReturnPct: 5.32,
  sampleAdequacy: "ROBUST",
  freshness: { dataThrough: "2026-02-02", state: "fresh" },
  warnings: [
    "This is historical/base-rate factor evidence, not a prediction or recommendation.",
    "The historical sample is through 2026-02-02 for the selected horizon; this is not today's or latest market-data snapshot.",
    "In V1, low-RSI requests are represented by the public weak momentum bucket; no raw RSI threshold is exposed.",
  ],
};

export const goldenUnsupportedFactorBacktestView: FactorBacktestView = {
  viewSchemaVersion: 1,
  state: "unavailable",
  source: "pg_factor_history",
  horizon: "60-day",
  criteria: [],
  freshness: { state: "unknown" },
  warnings: [
    "Unsupported public factor criteria: insider buying.",
    "Supported factor backtest criteria are valuation, quality, momentum, growth, leverage, and sector.",
  ],
};

export const goldenUnsupportedHorizonBacktestView: FactorBacktestView = {
  ...goldenUnsupportedFactorBacktestView,
  criteria: [
    { factor: "valuation", bucket: "ATTRACTIVE" },
    { factor: "quality", bucket: "STRONG" },
  ],
  warnings: ["Unsupported backtest horizon: 15-day."],
};

export const goldenCapabilityViews: Record<string, PgCapabilityViews> = {
  sectorLeaderboard: { sectorLeaderboardView: goldenSectorLeaderboardView },
  stockIdea: { stockIdeaView: goldenStockIdeaView },
  sectorDivergence: { sectorDivergenceView: goldenSectorDivergenceView },
  sectorDelta: { sectorDeltaView: goldenSectorDeltaView },
  stockVsSectorComparison: { comparisonView: goldenStockVsSectorComparisonView },
  sectorVsSectorComparison: { comparisonView: goldenSectorVsSectorComparisonView },
  symbolVsSymbolComparison: { comparisonView: goldenSymbolVsSymbolComparisonView },
  regimePlaybook: {
    regimeHistoricalPlaybookView: goldenRegimeHistoricalPlaybookView,
  },
  featureScreen: { featureScreenView: goldenFeatureScreenView },
  factorBacktest: { factorBacktestView: goldenFactorBacktestView },
};
