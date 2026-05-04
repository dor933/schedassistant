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
  assert.match(prompt, /this week/);
  assert.match(prompt, /freshness\.dataThrough/);
  assert.match(prompt, /2026-05-01/);
  assert.doesNotMatch(prompt, /researchObjects/);
  assert.doesNotMatch(prompt, /parts/);
  assert.doesNotMatch(prompt, /raw_sql/);
  assert.doesNotMatch(prompt, /edge_id/);
  assert.doesNotMatch(prompt, /hypothesis_id/);
  assert.doesNotMatch(prompt, /analog_rows/);
  assert.doesNotMatch(prompt, /path_rows/);
  assertNoFreshnessInternals(prompt);
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
  assertNoFreshnessInternals(prompt);
});

test("LLM prompt receives public-safe sector divergence view", () => {
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
    snapshots: { freshness: { dataThrough: "2026-05-01" } },
    toolOutputs: {},
    researchObjects: [],
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
  };

  const prompt = buildSystemPrompt(state);
  assert.match(prompt, /sectorDivergenceView/);
  assert.match(prompt, /Utilities/);
  assert.match(prompt, /sector conviction\/momentum divergence/i);
  assert.match(prompt, /not confirmed sector leadership/i);
  assert.match(prompt, /Do not expose or describe scoring formulas/i);
  assert.doesNotMatch(prompt, /divergenceScorePct/);
  assert.doesNotMatch(prompt, /setup_score/);
  assert.doesNotMatch(prompt, /score_formula/);
  assert.doesNotMatch(prompt, /researchObjects/);
  assert.doesNotMatch(prompt, /parts/);
  assert.doesNotMatch(prompt, /raw_sql/);
  assertNoFreshnessInternals(prompt);
});

test("LLM prompt carries only public stale freshness caveat", () => {
  const state: AskGrahamyState = {
    internalUserId: 1,
    conversationId: "conversation-1",
    message: "What stock looks interesting today?",
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
        asOfDate: "2026-04-30",
        rankingBasis: "setup_quality",
        rows: [
          {
            symbol: "GSL",
            rank: 1,
            reasonBullets: ["Sector-relative conviction bucket is HIGH."],
          },
        ],
        freshness: {
          dataThrough: "2026-04-30",
          state: "stale",
          warning:
            "This view uses data through 2026-04-30; treat it as a stale snapshot rather than a live current view.",
        },
        warnings: [
          "This view uses data through 2026-04-30; treat it as a stale snapshot rather than a live current view.",
        ],
      },
    },
  };

  const prompt = buildSystemPrompt(state);
  assert.match(prompt, /today/);
  assert.match(prompt, /2026-04-30/);
  assert.match(prompt, /stale snapshot/);
  assert.match(prompt, /do not call the data current/i);
  assertNoFreshnessInternals(prompt);
});

function assertNoFreshnessInternals(value: unknown): void {
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /md_research_refresh_latest/);
  assert.doesNotMatch(json, /md_research_refresh_stale/);
  assert.doesNotMatch(json, /md_features_daily/);
  assert.doesNotMatch(json, /md_historical_features_daily/);
  assert.doesNotMatch(json, /md_research_sector_peer_daily/);
  assert.doesNotMatch(json, /md_research_sector_regime_fwd_agg/);
  assert.doesNotMatch(json, /pipeline_state/);
  assert.doesNotMatch(json, /run_id/);
  assert.doesNotMatch(json, /last_success_at/);
  assert.doesNotMatch(json, /completed_at/);
  assert.doesNotMatch(json, /max_age/);
}
