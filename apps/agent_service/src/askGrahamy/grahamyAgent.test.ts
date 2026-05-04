import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "./grahamyAgent";
import type { AskGrahamyState } from "./types";

test("LLM prompt includes only public-safe sector leaderboard payload", () => {
  const state: AskGrahamyState = {
    internalUserId: 1,
    conversationId: "conversation-1",
    message: "Which sectors are leading on conviction this week?",
    warnings: [],
    classification: {
      intent: "sector_conviction_leaderboard",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      requiresTools: ["get_market_context"],
      confidence: "high",
      warnings: [],
    },
    snapshots: {
      freshness: { dataThrough: "2026-05-01" },
    },
    pgCapabilityViews: {
      sectorLeaderboardView: {
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
            evidenceStrength: "ADEQUATE",
            hitRatePct: 58.2,
            momentumBucket: "MIXED",
            priceMomentumSeparation: "conviction_but_weak_price_action",
            defensiveCyclicalLabel: "cyclical",
          },
        ],
        freshness: {
          dataThrough: "2026-05-01",
          state: "fresh",
        },
        warnings: [],
      },
    },
  };

  const prompt = buildSystemPrompt(state);
  assert.match(prompt, /sectorLeaderboardView/);
  assert.match(prompt, /Industrials/);
  assert.match(prompt, /Rank sectors only from those rows/i);
  assert.match(prompt, /PG base-rate\/current composite evidence/i);
  assert.doesNotMatch(prompt, /researchObjects/);
  assert.doesNotMatch(prompt, /parts/);
  assert.doesNotMatch(prompt, /publicSummary/);
  assert.doesNotMatch(prompt, /edge_id/);
  assert.doesNotMatch(prompt, /hypothesis_id/);
  assert.doesNotMatch(prompt, /raw_sql/);
  assert.doesNotMatch(prompt, /analog_rows/);
  assert.doesNotMatch(prompt, /path_rows/);
  assert.doesNotMatch(prompt, /gate_name/);
  assert.doesNotMatch(prompt, /internal_threshold/);
  assert.doesNotMatch(prompt, /md_research_sector_peer_daily/);
  assert.doesNotMatch(prompt, /completedAt/);
});

test("LLM prompt includes only public-safe sector divergence payload", () => {
  const state: AskGrahamyState = {
    internalUserId: 1,
    conversationId: "conversation-1",
    message: "Which sectors have conviction but weak price action?",
    warnings: [],
    classification: {
      intent: "sector_momentum_vs_conviction_divergence",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      requiresTools: ["get_market_context"],
      confidence: "high",
      warnings: [],
    },
    snapshots: {
      freshness: { dataThrough: "2026-05-01" },
    },
    pgCapabilityViews: {
      sectorDivergenceView: {
        viewSchemaVersion: 1,
        state: "complete",
        source: "pg_sector_peer_daily",
        period: "latest",
        asOfDate: "2026-05-01",
        rows: [
          {
            sector: "Utilities",
            rank: 1,
            convictionScorePct: 70,
            convictionBucket: "CONSTRUCTIVE",
            momentumScorePct: 30,
            momentumBucket: "WEAK",
            divergenceType: "conviction_but_weak_price_action",
            evidenceStrength: "ADEQUATE",
            interpretationBullets: [
              "Conviction is constructive but current price action is not confirming it.",
            ],
          },
        ],
        freshness: {
          dataThrough: "2026-05-01",
          state: "fresh",
        },
        warnings: [],
      },
    },
  };

  const prompt = buildSystemPrompt(state);
  assert.match(prompt, /sectorDivergenceView/);
  assert.match(prompt, /Utilities/);
  assert.match(prompt, /not confirmed sector leadership/i);
  assert.doesNotMatch(prompt, /divergenceScorePct/);
  assert.doesNotMatch(prompt, /score_formula/);
  assert.doesNotMatch(prompt, /researchObjects/);
  assert.doesNotMatch(prompt, /parts/);
  assert.doesNotMatch(prompt, /publicSummary/);
  assert.doesNotMatch(prompt, /raw_sql/);
  assert.doesNotMatch(prompt, /md_research_sector_peer_daily/);
  assert.doesNotMatch(prompt, /md_historical_features_daily/);
  assert.doesNotMatch(prompt, /md_research_sector_regime_fwd_agg/);
});

test("LLM prompt includes only public-safe week-over-week sector delta payload", () => {
  const state: AskGrahamyState = {
    internalUserId: 1,
    conversationId: "conversation-1",
    message: "Which sectors improved most versus last week?",
    warnings: [],
    classification: {
      intent: "week_over_week_sector_delta",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      requiresTools: ["get_market_context"],
      confidence: "high",
      warnings: [],
    },
    snapshots: {
      freshness: { dataThrough: "2026-04-27" },
    },
    pgCapabilityViews: {
      sectorDeltaView: {
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
            convictionDeltaPct: 8,
            momentumDeltaPct: 5,
            direction: "improved",
            interpretationBullets: [
              "Weekly conviction proxy improved by 8 points.",
            ],
          },
        ],
        freshness: {
          dataThrough: "2026-04-27",
          state: "fresh",
        },
        warnings: [],
      },
    },
  };

  const prompt = buildSystemPrompt(state);
  assert.match(prompt, /sectorDeltaView/);
  assert.match(prompt, /Technology/);
  assert.match(prompt, /weekly PG sector-history\/proxy delta evidence/i);
  assert.match(prompt, /currentAsOfDate/);
  assert.match(prompt, /priorAsOfDate/);
  assert.doesNotMatch(prompt, /sector_delta_formula/);
  assert.doesNotMatch(prompt, /conviction_formula/);
  assert.doesNotMatch(prompt, /momentum_formula/);
  assert.doesNotMatch(prompt, /researchObjects/);
  assert.doesNotMatch(prompt, /parts/);
  assert.doesNotMatch(prompt, /publicSummary/);
  assert.doesNotMatch(prompt, /raw_sql/);
  assert.doesNotMatch(prompt, /md_research_sector_monday_hist/);
});

test("LLM prompt includes only public-safe comparison payload", () => {
  const state: AskGrahamyState = {
    internalUserId: 1,
    conversationId: "conversation-1",
    message: "Compare GSL to its sector",
    warnings: [],
    classification: {
      intent: "comparison",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      comparison: {
        comparisonType: "stock_vs_sector",
        left: { type: "stock", symbol: "GSL" },
        right: { type: "implicit_stock_sector" },
      },
      requiresTools: ["get_market_context"],
      confidence: "high",
      warnings: [],
    },
    snapshots: {
      freshness: { dataThrough: "2026-05-01" },
    },
    pgCapabilityViews: {
      comparisonView: {
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
          },
        },
        right: {
          type: "sector",
          label: "Industrials",
          sector: "Industrials",
          metrics: {
            convictionScorePct: 55,
            convictionBucket: "MIXED",
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
        freshness: {
          dataThrough: "2026-05-01",
          state: "fresh",
        },
        warnings: ["Daily path-risk comparison is unavailable in V1."],
      },
    },
  };

  const prompt = buildSystemPrompt(state);
  assert.match(prompt, /comparisonView/);
  assert.match(prompt, /GSL/);
  assert.match(prompt, /Industrials/);
  assert.match(prompt, /PG current\/base-rate comparison evidence/i);
  assert.doesNotMatch(prompt, /comparison_formula/);
  assert.doesNotMatch(prompt, /raw_sql/);
  assert.doesNotMatch(prompt, /researchObjects/);
  assert.doesNotMatch(prompt, /parts/);
  assert.doesNotMatch(prompt, /publicSummary/);
  assert.doesNotMatch(prompt, /md_features_daily/);
  assert.doesNotMatch(prompt, /md_research_sector_peer_daily/);
});
