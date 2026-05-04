import test from "node:test";
import assert from "node:assert/strict";
import { buildSectorDeltaView } from "../pgCapabilities/sectorDelta";
import type { Classification } from "../types";

const classification: Classification = {
  intent: "week_over_week_sector_delta",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

test("sector delta includes only true improvement rows for broad improvement prompts", async () => {
  const result = await buildSectorDeltaView(
    {
      classification,
      message: "Which sectors improved most versus last week?",
      snapshots: {},
      toolOutputs: {},
    },
    {
      queryRunner: async () => [
        {
          sector: "Technology",
          rank: 1,
          current_conviction_score_pct: 76.2,
          prior_conviction_score_pct: 68.1,
          conviction_delta_pct: 8.1,
          current_conviction_bucket: "HIGH",
          prior_conviction_bucket: "CONSTRUCTIVE",
          current_momentum_bucket: "STRONG",
          prior_momentum_bucket: "MIXED",
          momentum_delta_pct: 5.6,
          direction: "improved",
          include_in_public: true,
          current_as_of_date: "2026-04-27",
          prior_as_of_date: "2026-04-20",
          weekly_freshness_state: "FRESH",
          weekly_completed_at: "2026-04-28T12:30:04Z",
          raw_sql: "must-not-leak",
          sector_delta_formula: "must-not-leak",
        },
        {
          sector: "Energy",
          rank: 2,
          conviction_delta_pct: -2,
          momentum_delta_pct: -1,
          direction: "deteriorated",
          include_in_public: false,
          current_as_of_date: "2026-04-27",
          prior_as_of_date: "2026-04-20",
        },
      ],
    },
  );

  const view = result.views.sectorDeltaView;
  assert.ok(view);
  assert.equal(view.state, "complete");
  assert.equal(view.rankingBasis, "overall_change");
  assert.equal(view.currentAsOfDate, "2026-04-27");
  assert.equal(view.priorAsOfDate, "2026-04-20");
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0].sector, "Technology");
  assert.equal(view.rows[0].direction, "improved");
  assertNoForbiddenPublicKeys(view);
});

test("sector delta exposes only negative momentum rows for lost-momentum prompts", async () => {
  let replacements: Record<string, unknown> = {};
  const result = await buildSectorDeltaView(
    {
      classification,
      message: "Which sectors lost momentum this week?",
      snapshots: {},
      toolOutputs: {},
    },
    {
      queryRunner: async (params) => {
        replacements = params;
        return [
          {
            sector: "Energy",
            rank: 1,
            conviction_delta_pct: 0,
            momentum_delta_pct: -9,
            current_momentum_bucket: "WEAK",
            prior_momentum_bucket: "STRONG",
            direction: "deteriorated",
            include_in_public: true,
            current_as_of_date: "2026-04-27",
            prior_as_of_date: "2026-04-20",
            weekly_freshness_state: "FRESH",
            weekly_completed_at: "2026-04-28T12:30:04Z",
          },
          {
            sector: "Financial Services",
            rank: 2,
            conviction_delta_pct: -2,
            momentum_delta_pct: 0,
            direction: "deteriorated",
            include_in_public: false,
            current_as_of_date: "2026-04-27",
            prior_as_of_date: "2026-04-20",
          },
        ];
      },
    },
  );

  assert.equal(replacements.DIRECTION_FILTER, "momentum_deteriorated");
  const view = result.views.sectorDeltaView;
  assert.ok(view);
  assert.equal(view.rankingBasis, "deterioration");
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0].sector, "Energy");
  assert.equal(view.rows[0].direction, "deteriorated");
  assert.ok((view.rows[0].momentumDeltaPct ?? 0) < 0);
  assert.match(view.rows[0].interpretationBullets.join(" "), /deteriorated/i);
  assertNoForbiddenPublicKeys(view);
});

test("sector delta returns complete empty view when no meaningful delta exists", async () => {
  const result = await buildSectorDeltaView(
    {
      classification,
      message: "What changed since last week?",
      snapshots: {},
      toolOutputs: {},
    },
    {
      queryRunner: async () => [
        {
          sector: "Utilities",
          rank: 1,
          conviction_delta_pct: 0.5,
          momentum_delta_pct: 0.4,
          direction: "flat",
          include_in_public: false,
          current_as_of_date: "2026-04-27",
          prior_as_of_date: "2026-04-20",
          weekly_freshness_state: "FRESH",
          weekly_completed_at: "2026-04-28T12:30:04Z",
        },
      ],
    },
  );

  const view = result.views.sectorDeltaView;
  assert.ok(view);
  assert.equal(view.state, "complete");
  assert.deepEqual(view.rows, []);
  assert.match(
    view.warnings.join(" "),
    /No meaningful week-over-week sector delta was found/i,
  );
  assertNoForbiddenPublicKeys(view);
});

test("sector delta is unavailable when current or prior weekly baseline is absent", async () => {
  const result = await buildSectorDeltaView(
    {
      classification,
      message: "Which sectors gained conviction week-over-week?",
      snapshots: {},
      toolOutputs: {},
    },
    { queryRunner: async () => [] },
  );

  const view = result.views.sectorDeltaView;
  assert.ok(view);
  assert.equal(view.state, "unavailable");
  assert.deepEqual(view.rows, []);
  assert.match(view.warnings.join(" "), /weekly sector baseline is missing/i);
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
  assert.doesNotMatch(json, /feature_rules/);
  assert.doesNotMatch(json, /sector_delta_formula/);
  assert.doesNotMatch(json, /conviction_formula/);
  assert.doesNotMatch(json, /momentum_formula/);
  assert.doesNotMatch(json, /score_formula/);
  assert.doesNotMatch(json, /scoring_formula/);
  assert.doesNotMatch(json, /md_research_refresh_latest/);
  assert.doesNotMatch(json, /md_research_refresh_stale/);
  assert.doesNotMatch(json, /md_research_sector_monday_hist/);
  assert.doesNotMatch(json, /md_research_sector_peer_daily/);
  assert.doesNotMatch(json, /md_historical_features_daily/);
  assert.doesNotMatch(json, /pipeline_state/);
  assert.doesNotMatch(json, /run_id/);
  assert.doesNotMatch(json, /completed_at/);
  assert.doesNotMatch(json, /max_age/);
}
