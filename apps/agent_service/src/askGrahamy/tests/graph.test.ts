import test from "node:test";
import assert from "node:assert/strict";
import { runAskGrahamyGraph } from "../graph";
import type { Classification, PublicResearchView } from "../types";

const leaderboardClassification: Classification = {
  intent: "sector_conviction_leaderboard",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

const stockIdeaClassification: Classification = {
  intent: "stock_idea_discovery",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

const divergenceClassification: Classification = {
  intent: "sector_momentum_vs_conviction_divergence",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

const sectorDeltaClassification: Classification = {
  intent: "week_over_week_sector_delta",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

const comparisonClassification: Classification = {
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
};

test("graph loads sectorLeaderboardView for leaderboard intent without Research Object anchors", async () => {
  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-1",
      message: "Which sectors are leading on conviction this week?",
      classification: leaderboardClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-01" },
        }),
      } as any,
      pgCapabilityRunner: async () => ({
        views: {
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
              },
            ],
            freshness: { dataThrough: "2026-05-01", state: "fresh" },
            warnings: [],
          },
        },
        warnings: [],
      }),
      grahamyAgentRunner: async () => ({
        answerText: "Industrials leads the supplied PG sector leaderboard.",
        suggestedFollowups: [],
        warnings: [],
      }),
    },
  );

  assert.equal(response.answerType, "sector");
  assert.equal(response.meta.researchObjectKeys?.length, 0);
  assert.deepEqual(response.meta.sourcesUsed, [
    { type: "research", name: "sector_conviction_leaderboard" },
  ]);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.sectorLeaderboardView?.rows[0].sector, "Industrials");
  assert.equal(publicView.researchObjectViews.length, 0);
});

test("graph loads stockIdeaView for stock idea intent without ticker anchors", async () => {
  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-1",
      message: "Give me an interesting stock",
      classification: stockIdeaClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-01" },
        }),
      } as any,
      pgCapabilityRunner: async () => ({
        views: {
          stockIdeaView: {
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
                reasonBullets: ["Sector-relative conviction bucket is HIGH."],
              },
            ],
            freshness: { dataThrough: "2026-05-01", state: "fresh" },
            warnings: ["These are research candidates to review."],
          },
        },
        warnings: [],
      }),
      grahamyAgentRunner: async () => ({
        answerText: "GSL is a research candidate from the supplied PG stock idea view.",
        suggestedFollowups: [],
        warnings: [],
      }),
    },
  );

  assert.equal(response.answerType, "stock");
  assert.equal(response.meta.researchObjectKeys?.length, 0);
  assert.deepEqual(response.meta.sourcesUsed, [
    { type: "research", name: "stock_idea_discovery" },
  ]);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.stockIdeaView?.rows[0].symbol, "GSL");
  assert.equal(publicView.researchObjectViews.length, 0);
});

test("graph loads sectorDivergenceView for divergence intent without anchors", async () => {
  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-1",
      message: "Which sectors have conviction but weak price action?",
      classification: divergenceClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-01" },
        }),
      } as any,
      pgCapabilityRunner: async () => ({
        views: {
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
                hitRatePct: 58.2,
                evidenceStrength: "ADEQUATE",
                interpretationBullets: [
                  "Conviction is constructive but current price action is not confirming it.",
                ],
              },
            ],
            freshness: { dataThrough: "2026-05-01", state: "fresh" },
            warnings: [],
          },
        },
        warnings: [],
      }),
      grahamyAgentRunner: async () => ({
        answerText: "Utilities has conviction but weak price action in the supplied PG view.",
        suggestedFollowups: [],
        warnings: [],
      }),
    },
  );

  assert.equal(response.answerType, "sector");
  assert.equal(response.meta.researchObjectKeys?.length, 0);
  assert.deepEqual(response.meta.sourcesUsed, [
    {
      type: "research",
      name: "sector_momentum_vs_conviction_divergence",
    },
  ]);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.sectorDivergenceView?.rows[0].sector, "Utilities");
  assert.equal(publicView.researchObjectViews.length, 0);
});

test("graph loads sectorDeltaView for week-over-week sector delta intent without anchors", async () => {
  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-1",
      message: "Which sectors improved most versus last week?",
      classification: sectorDeltaClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-04-27" },
        }),
      } as any,
      pgCapabilityRunner: async () => ({
        views: {
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
                currentConvictionScorePct: 76,
                priorConvictionScorePct: 68,
                convictionDeltaPct: 8,
                currentConvictionBucket: "HIGH",
                priorConvictionBucket: "CONSTRUCTIVE",
                currentMomentumBucket: "STRONG",
                priorMomentumBucket: "MIXED",
                momentumDeltaPct: 5,
                direction: "improved",
                interpretationBullets: [
                  "Weekly conviction proxy improved by 8 points.",
                ],
              },
            ],
            freshness: { dataThrough: "2026-04-27", state: "fresh" },
            warnings: [],
          },
        },
        warnings: [],
      }),
      grahamyAgentRunner: async () => ({
        answerText: "Technology improved in the supplied PG weekly sector delta view.",
        suggestedFollowups: [],
        warnings: [],
      }),
    },
  );

  assert.equal(response.answerType, "sector");
  assert.equal(response.meta.researchObjectKeys?.length, 0);
  assert.deepEqual(response.meta.sourcesUsed, [
    {
      type: "research",
      name: "week_over_week_sector_delta",
    },
  ]);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.sectorDeltaView?.rows[0].sector, "Technology");
  assert.equal(publicView.researchObjectViews.length, 0);
});

test("graph loads comparisonView for stock-vs-sector comparison without Research Object anchors", async () => {
  const response = await runAskGrahamyGraph(
    {
      userId: "external-user-1",
      conversationId: "conversation-1",
      message: "Compare GSL to its sector",
      classification: comparisonClassification,
      priorResearchObjects: [],
    },
    1,
    {
      snapshotClient: {
        fetchPublishedSnapshots: async () => ({
          daily_brief: { regime: "NEUTRAL" },
          freshness: { dataThrough: "2026-05-01" },
        }),
      } as any,
      pgCapabilityRunner: async () => ({
        views: {
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
            summaryBullets: [
              "GSL screens stronger than Industrials on conviction.",
            ],
            freshness: { dataThrough: "2026-05-01", state: "fresh" },
            warnings: ["Daily path-risk comparison is unavailable in V1."],
          },
        },
        warnings: [],
      }),
      grahamyAgentRunner: async () => ({
        answerText: "GSL is stronger than its sector on conviction in the supplied PG comparison view.",
        suggestedFollowups: [],
        warnings: [],
      }),
    },
  );

  assert.equal(response.answerType, "mixed");
  assert.equal(response.meta.researchObjectKeys?.length, 0);
  assert.deepEqual(response.meta.sourcesUsed, [
    { type: "research", name: "stock_vs_sector_comparison" },
  ]);
  const publicView = response.research.publicResearchView as PublicResearchView;
  assert.equal(publicView.comparisonView?.left.symbol, "GSL");
  assert.equal(publicView.researchObjectViews.length, 0);
});
