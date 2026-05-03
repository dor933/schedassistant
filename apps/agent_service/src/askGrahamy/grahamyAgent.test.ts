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
          sources: [
            {
              name: "md_research_sector_peer_daily",
              completedAt: "2026-05-02T12:30:04Z",
              state: "FRESH",
            },
          ],
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
});
