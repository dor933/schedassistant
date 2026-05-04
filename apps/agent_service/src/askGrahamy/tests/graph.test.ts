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
