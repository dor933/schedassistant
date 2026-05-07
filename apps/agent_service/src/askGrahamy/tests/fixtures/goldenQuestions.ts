import type { Classification, Intent } from "../../types";

export type GoldenQuestionCase = {
  question: string;
  expectedIntent: Intent;
  expectedFocus?: "risk";
  expectedView:
    | "researchObjectViews"
    | "sectorLeaderboardView"
    | "stockIdeaView"
    | "sectorDivergenceView"
    | "sectorDeltaView"
    | "comparisonView"
    | "regimeHistoricalPlaybookView"
    | "featureScreenView"
    | "factorBacktestView"
    | "clarification";
  anchorless: boolean;
};

export const GOLDEN_QUESTIONS: GoldenQuestionCase[] = [
  {
    question: "Tell me about GSL",
    expectedIntent: "stock",
    expectedView: "researchObjectViews",
    anchorless: false,
  },
  {
    question: "How is Energy?",
    expectedIntent: "sector",
    expectedView: "researchObjectViews",
    anchorless: false,
  },
  {
    question: "What is the market regime now?",
    expectedIntent: "regime",
    expectedView: "researchObjectViews",
    anchorless: false,
  },
  {
    question: "Which sectors are leading on conviction this week?",
    expectedIntent: "sector_conviction_leaderboard",
    expectedView: "sectorLeaderboardView",
    anchorless: true,
  },
  {
    question: "Give me an interesting stock",
    expectedIntent: "stock_idea_discovery",
    expectedView: "stockIdeaView",
    anchorless: true,
  },
  {
    question: "Which sectors have conviction but weak price action?",
    expectedIntent: "sector_momentum_vs_conviction_divergence",
    expectedView: "sectorDivergenceView",
    anchorless: true,
  },
  {
    question: "Which sectors improved most versus last week?",
    expectedIntent: "week_over_week_sector_delta",
    expectedView: "sectorDeltaView",
    anchorless: true,
  },
  {
    question: "Compare GSL to its sector",
    expectedIntent: "comparison",
    expectedView: "comparisonView",
    anchorless: true,
  },
  {
    question: "Compare Technology vs Industrials",
    expectedIntent: "comparison",
    expectedView: "comparisonView",
    anchorless: true,
  },
  {
    question: "Compare GSL vs DAC",
    expectedIntent: "comparison",
    expectedView: "comparisonView",
    anchorless: true,
  },
  {
    question: "How risky is GSL?",
    expectedIntent: "stock",
    expectedFocus: "risk",
    expectedView: "researchObjectViews",
    anchorless: false,
  },
  {
    question: "What usually works in this regime?",
    expectedIntent: "market_regime_historical_playbook",
    expectedView: "regimeHistoricalPlaybookView",
    anchorless: true,
  },
  {
    question: "Find me cheap quality stocks",
    expectedIntent: "feature_screen",
    expectedView: "featureScreenView",
    anchorless: true,
  },
  {
    question: "What happens historically when RSI is low and valuation is attractive?",
    expectedIntent: "factor_conditioned_backtest",
    expectedView: "factorBacktestView",
    anchorless: true,
  },
];

export const RO_CLASSIFICATIONS: Record<"stock" | "sector" | "regime" | "risk", Classification> = {
  stock: {
    intent: "stock",
    symbols: ["GSL"],
    sectors: [],
    regimeRequested: false,
    isFollowUp: false,
    requiresTools: ["get_stock_snapshot_context", "get_market_context"],
    confidence: "high",
    warnings: [],
  },
  sector: {
    intent: "sector",
    symbols: [],
    sectors: ["Energy"],
    regimeRequested: false,
    isFollowUp: false,
    requiresTools: ["get_sector_snapshot_context", "get_market_context"],
    confidence: "high",
    warnings: [],
  },
  regime: {
    intent: "regime",
    symbols: [],
    sectors: [],
    regimeRequested: true,
    isFollowUp: false,
    requiresTools: ["get_market_context"],
    confidence: "high",
    warnings: [],
  },
  risk: {
    intent: "stock",
    symbols: ["GSL"],
    sectors: [],
    regimeRequested: false,
    isFollowUp: false,
    focus: "risk",
    requiresTools: ["get_stock_snapshot_context", "get_market_context"],
    confidence: "high",
    warnings: [],
  },
};
