import test from "node:test";
import assert from "node:assert/strict";
import { buildSectorConvictionLeaderboardView } from "./pgCapabilities/sectorConvictionLeaderboard";
import { compilePublicResearchView } from "./publicResearch";
import type { Classification } from "./types";

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

test("sector conviction leaderboard returns complete public view with overlay", async () => {
  let replacements: Record<string, unknown> = {};
  const result = await buildSectorConvictionLeaderboardView(
    {
      classification: leaderboardClassification,
      message: "Which sectors are leading on conviction this week?",
      snapshots: {},
      toolOutputs: {},
    },
    {
      maxRows: 50,
      queryRunner: async (params) => {
        replacements = params;
        return [
          {
            sector: "Industrials",
            rank: 1,
            conviction_score_pct: 82.44,
            conviction_bucket: "HIGH",
            evidence_strength: "ADEQUATE",
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
            raw_sql: "must-not-leak",
            edge_id: "must-not-leak",
          },
        ];
      },
    },
  );

  assert.equal(replacements.MAX_ROWS, 20);
  assert.equal(replacements.RANK_BY, "conviction");
  const view = result.views.sectorLeaderboardView;
  assert.ok(view);
  assert.equal(view.state, "complete");
  assert.equal(view.source, "pg_sector_peer_daily");
  assert.equal(view.asOfDate, "2026-05-01");
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0].sector, "Industrials");
  assert.equal(view.rows[0].convictionScorePct, 82.4);
  assert.equal(view.rows[0].hitRatePct, 58.2);
  assertNoForbiddenPublicKeys(view);
});

test("sector conviction leaderboard returns partial when forward overlay is absent", async () => {
  const result = await buildSectorConvictionLeaderboardView(
    {
      classification: leaderboardClassification,
      message: "Which sectors have conviction but weak price action?",
      snapshots: {},
      toolOutputs: {},
    },
    {
      queryRunner: async () => [
        {
          sector: "Utilities",
          rank: 1,
          conviction_score_pct: 70,
          conviction_bucket: "CONSTRUCTIVE",
          evidence_strength: "WEAK",
          momentum_bucket: "WEAK",
          price_momentum_separation: "conviction_but_weak_price_action",
          defensive_cyclical_label: "defensive",
          as_of_date: "2026-05-01",
          overlay_available: false,
        },
      ],
    },
  );

  const view = result.views.sectorLeaderboardView;
  assert.ok(view);
  assert.equal(view.state, "partial");
  assert.equal(view.rankingBasis, "divergence");
  assert.match(view.warnings.join(" "), /overlay is unavailable/i);
  assert.equal(view.rows[0].hitRatePct, undefined);
});

test("sector conviction leaderboard returns unavailable when source has no rows", async () => {
  const result = await buildSectorConvictionLeaderboardView(
    {
      classification: leaderboardClassification,
      message: "Show me the sector conviction leaderboard",
      snapshots: {},
      toolOutputs: {},
    },
    { queryRunner: async () => [] },
  );

  const view = result.views.sectorLeaderboardView;
  assert.ok(view);
  assert.equal(view.state, "unavailable");
  assert.deepEqual(view.rows, []);
  assert.match(view.warnings.join(" "), /No sector leaderboard rows/i);
});

test("publicResearchView carries sectorLeaderboardView without Research Objects", async () => {
  const result = await buildSectorConvictionLeaderboardView(
    {
      classification: leaderboardClassification,
      message: "Which sectors are leading on conviction this week?",
      snapshots: {},
      toolOutputs: {},
    },
    {
      queryRunner: async () => [
        {
          sector: "Technology",
          rank: 1,
          conviction_score_pct: 80,
          conviction_bucket: "HIGH",
          evidence_strength: "ROBUST",
          hit_rate_pct: 60,
          momentum_bucket: "STRONG",
          price_momentum_separation: "price_action_confirms_conviction",
          defensive_cyclical_label: "cyclical",
          as_of_date: "2026-05-01",
          overlay_available: true,
        },
      ],
    },
  );

  const publicView = compilePublicResearchView({
    classification: leaderboardClassification,
    snapshots: { freshness: { dataThrough: "2026-05-01" } },
    toolOutputs: {},
    researchObjects: [],
    pgCapabilityViews: result.views,
    warnings: [],
  });

  assert.equal(publicView.objectType, "sector");
  assert.equal(publicView.researchObjectViews.length, 0);
  assert.deepEqual(publicView.researchObjectKeys, []);
  assert.equal(publicView.sectorLeaderboardView?.rows[0].sector, "Technology");
  assertNoForbiddenPublicKeys(publicView);
});

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
