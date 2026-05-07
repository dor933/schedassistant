import test from "node:test";
import assert from "node:assert/strict";
import { buildSectorConvictionLeaderboardView } from "../pgCapabilities/sectorConvictionLeaderboard";
import type { Classification } from "../types";

const classification: Classification = {
  intent: "sector_conviction_leaderboard",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

test("sector leaderboard capability returns complete public-safe rows", async () => {
  const restore = configureExternalPgForTest();
  try {
    const result = await buildSectorConvictionLeaderboardView(
      {
        classification,
        message: "Which sectors are leading on conviction this week?",
        snapshots: {},
        toolOutputs: {},
      },
      {
        queryRunner: async () => [
          {
            sector: "Industrials",
            rank: 1,
            conviction_score_pct: 81.24,
            conviction_bucket: "HIGH",
            evidence_strength: "ROBUST",
            hit_rate_pct: 58.22,
            momentum_bucket: "MIXED",
            price_momentum_separation: "conviction_but_weak_price_action",
            defensive_cyclical_label: "cyclical",
            as_of_date: "2026-05-01",
            peer_freshness_state: "FRESH",
            peer_completed_at: "2026-05-02T12:30:04Z",
            forward_freshness_state: "FRESH",
            forward_completed_at: "2026-04-28T10:55:23Z",
            overlay_available: true,
          },
        ],
      },
    );

    const view = result.views.sectorLeaderboardView;
    assert.equal(view?.state, "complete");
    assert.equal(view?.source, "pg_sector_peer_daily");
    assert.equal(view?.asOfDate, "2026-05-01");
    assert.equal(view?.rows.length, 1);
    assert.deepEqual(view?.rows[0], {
      sector: "Industrials",
      rank: 1,
      convictionScorePct: 81.2,
      convictionBucket: "HIGH",
      evidenceStrength: "ROBUST",
      hitRatePct: 58.2,
      momentumBucket: "MIXED",
      priceMomentumSeparation: "conviction_but_weak_price_action",
      defensiveCyclicalLabel: "cyclical",
    });
    assertNoForbiddenPublicKeys(view);
  } finally {
    restore();
  }
});

test("sector leaderboard capability returns partial when forward overlay is unavailable", async () => {
  const restore = configureExternalPgForTest();
  try {
    const result = await buildSectorConvictionLeaderboardView(
      {
        classification,
        message: "Which sectors have strongest historical forward profile?",
        snapshots: {},
        toolOutputs: {},
      },
      {
        queryRunner: async () => [
          {
            sector: "Technology",
            rank: 1,
            conviction_score_pct: 66,
            conviction_bucket: "CONSTRUCTIVE",
            evidence_strength: "ADEQUATE",
            momentum_bucket: "STRONG",
            price_momentum_separation: "price_action_confirms_conviction",
            defensive_cyclical_label: "cyclical",
            as_of_date: "2026-05-01",
            overlay_available: false,
          },
        ],
      },
    );

    const view = result.views.sectorLeaderboardView;
    assert.equal(view?.state, "partial");
    assert.equal(view?.rankingBasis, "historical_forward");
    assert.equal(view?.rows[0]?.hitRatePct, undefined);
    assert.match(view?.warnings.join(" ") ?? "", /overlay is unavailable/i);
  } finally {
    restore();
  }
});

test("sector leaderboard capability returns unavailable when source has no rows", async () => {
  const restore = configureExternalPgForTest();
  try {
    const result = await buildSectorConvictionLeaderboardView(
      {
        classification,
        message: "Show me the sector conviction leaderboard",
        snapshots: {},
        toolOutputs: {},
      },
      { queryRunner: async () => [] },
    );

    const view = result.views.sectorLeaderboardView;
    assert.equal(view?.state, "unavailable");
    assert.equal(view?.rows.length, 0);
    assert.match(view?.warnings.join(" ") ?? "", /No sector leaderboard rows/i);
  } finally {
    restore();
  }
});

function configureExternalPgForTest(): () => void {
  const previousHost = process.env.EXTERNAL_PG_HOST;
  const previousDb = process.env.EXTERNAL_PG_DATABASE;
  process.env.EXTERNAL_PG_HOST = "configured-for-test";
  process.env.EXTERNAL_PG_DATABASE = "configured-for-test";
  return () => {
    if (previousHost == null) delete process.env.EXTERNAL_PG_HOST;
    else process.env.EXTERNAL_PG_HOST = previousHost;
    if (previousDb == null) delete process.env.EXTERNAL_PG_DATABASE;
    else process.env.EXTERNAL_PG_DATABASE = previousDb;
  };
}

function assertNoForbiddenPublicKeys(value: unknown): void {
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /researchObjects/);
  assert.doesNotMatch(json, /parts/);
  assert.doesNotMatch(json, /publicSummary/);
  assert.doesNotMatch(json, /edge_id/);
  assert.doesNotMatch(json, /hypothesis_id/);
  assert.doesNotMatch(json, /raw_sql/);
  assert.doesNotMatch(json, /analog_rows/);
  assert.doesNotMatch(json, /path_rows/);
  assert.doesNotMatch(json, /gate_name/);
  assert.doesNotMatch(json, /internal_threshold/);
}
