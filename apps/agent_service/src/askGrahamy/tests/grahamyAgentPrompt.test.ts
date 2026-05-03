import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../grahamyAgent";
import type { AskGrahamyState } from "../types";

test("LLM prompt receives public-safe sector leaderboard view", () => {
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
    snapshots: { freshness: { dataThrough: "2026-05-01" } },
    toolOutputs: {},
    researchObjects: [],
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
            convictionScorePct: 81.2,
            convictionBucket: "HIGH",
            hitRatePct: 58.2,
          },
        ],
        freshness: { dataThrough: "2026-05-01", state: "fresh" },
        warnings: [],
      },
    },
  };

  const prompt = buildSystemPrompt(state);
  assert.match(prompt, /sectorLeaderboardView/);
  assert.match(prompt, /Industrials/);
  assert.match(prompt, /rank sectors only/i);
  assert.match(prompt, /validated live edge/i);
  assert.doesNotMatch(prompt, /researchObjects/);
  assert.doesNotMatch(prompt, /parts/);
  assert.doesNotMatch(prompt, /raw_sql/);
  assert.doesNotMatch(prompt, /edge_id/);
  assert.doesNotMatch(prompt, /hypothesis_id/);
  assert.doesNotMatch(prompt, /analog_rows/);
  assert.doesNotMatch(prompt, /path_rows/);
});

test("LLM prompt receives public-safe stock idea view", () => {
  const state: AskGrahamyState = {
    internalUserId: 1,
    conversationId: "conversation-1",
    message: "Give me an interesting stock",
    warnings: [],
    classification: {
      intent: "stock_idea_discovery",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      requiresTools: ["get_market_context"],
      confidence: "high",
      warnings: [],
    },
    snapshots: { freshness: { dataThrough: "2026-05-01" } },
    toolOutputs: {},
    researchObjects: [],
    pgCapabilityViews: {
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
            convictionScorePct: 81.2,
            convictionBucket: "HIGH",
            reasonBullets: ["Sector-relative conviction bucket is HIGH."],
          },
        ],
        freshness: { dataThrough: "2026-05-01", state: "fresh" },
        warnings: ["These are research candidates to review."],
      },
    },
  };

  const prompt = buildSystemPrompt(state);
  assert.match(prompt, /stockIdeaView/);
  assert.match(prompt, /GSL/);
  assert.match(prompt, /research candidates/i);
  assert.match(prompt, /buy\/sell recommendations/i);
  assert.match(prompt, /PG current\/base-rate evidence/i);
  assert.doesNotMatch(prompt, /researchObjects/);
  assert.doesNotMatch(prompt, /parts/);
  assert.doesNotMatch(prompt, /raw_sql/);
  assert.doesNotMatch(prompt, /edge_id/);
  assert.doesNotMatch(prompt, /hypothesis_id/);
  assert.doesNotMatch(prompt, /analog_rows/);
  assert.doesNotMatch(prompt, /path_rows/);
  assert.doesNotMatch(prompt, /setup_score/);
});
