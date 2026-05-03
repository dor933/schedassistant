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
