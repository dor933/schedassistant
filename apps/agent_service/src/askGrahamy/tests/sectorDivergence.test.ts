import test from "node:test";
import assert from "node:assert/strict";
import { buildSectorDivergenceView } from "../pgCapabilities/sectorDivergence";
import type { Classification } from "../types";

const classification: Classification = {
  intent: "sector_momentum_vs_conviction_divergence",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

test("sector divergence capability returns complete public-safe rows", async () => {
  const restore = configureExternalPgForTest();
  try {
    let replacements: Record<string, unknown> = {};
    const result = await buildSectorDivergenceView(
      {
        classification,
        message: "Which sectors have conviction but weak price action?",
        snapshots: {},
        toolOutputs: {},
      },
      {
        maxRows: 50,
        queryRunner: async (params) => {
          replacements = params;
          return [
            {
              sector: "Utilities",
              rank: 1,
              conviction_score_pct: 70.04,
              conviction_bucket: "CONSTRUCTIVE",
              momentum_score_pct: 30,
              momentum_bucket: "WEAK",
              divergence_type: "conviction_but_weak_price_action",
              evidence_strength: "ADEQUATE",
              hit_rate_pct: 58.22,
              as_of_date: "2026-05-01",
              peer_freshness_state: "FRESH",
              peer_completed_at: "2026-05-02T12:30:04Z",
              forward_freshness_state: "FRESH",
              forward_completed_at: "2026-04-28T10:55:23Z",
              overlay_available: true,
              evaluated_sector_count: 2,
              clear_divergence_count: 1,
              divergence_score_pct: 91,
              score_formula: "must-not-leak",
              raw_sql: "must-not-leak",
            },
            {
              sector: "Industrials",
              rank: 2,
              conviction_score_pct: 50,
              conviction_bucket: "MIXED",
              momentum_score_pct: 75,
              momentum_bucket: "STRONG",
              divergence_type: "in_line",
              evidence_strength: "ROBUST",
              hit_rate_pct: 56.2,
              as_of_date: "2026-05-01",
              overlay_available: true,
              evaluated_sector_count: 2,
              clear_divergence_count: 1,
            },
          ];
        },
      },
    );

    assert.equal(replacements.MAX_ROWS, 20);
    const view = result.views.sectorDivergenceView;
    assert.equal(view?.state, "complete");
    assert.equal(view?.source, "pg_sector_peer_daily");
    assert.equal(view?.asOfDate, "2026-05-01");
    assert.equal(view?.evaluatedSectorCount, 2);
    assert.equal(view?.clearDivergenceCount, 1);
    assert.equal(view?.rows.length, 1);
    assert.deepEqual(view?.rows[0], {
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
        "Conviction bucket is CONSTRUCTIVE.",
        "Price momentum bucket is WEAK.",
        "Conviction is constructive but current price action is not confirming it.",
        "Historical forward hit-rate evidence is available.",
      ],
    });
    assertNoForbiddenPublicKeys(view);
  } finally {
    restore();
  }
});

test("sector divergence capability returns complete empty view when no clear divergence exists", async () => {
  const restore = configureExternalPgForTest();
  try {
    const result = await buildSectorDivergenceView(
      {
        classification,
        message: "Which sectors have conviction but weak price action?",
        snapshots: {},
        toolOutputs: {},
      },
      {
        queryRunner: async () => [
          {
            sector: "Industrials",
            rank: 1,
            conviction_score_pct: 50,
            conviction_bucket: "MIXED",
            momentum_score_pct: 75,
            momentum_bucket: "STRONG",
            divergence_type: "in_line",
            evidence_strength: "ROBUST",
            hit_rate_pct: 56.2,
            as_of_date: "2026-05-01",
            peer_freshness_state: "FRESH",
            peer_completed_at: "2026-05-02T12:30:04Z",
            overlay_available: true,
            evaluated_sector_count: 10,
            clear_divergence_count: 0,
          },
        ],
      },
    );

    const view = result.views.sectorDivergenceView;
    assert.equal(view?.state, "complete");
    assert.equal(view?.evaluatedSectorCount, 10);
    assert.equal(view?.clearDivergenceCount, 0);
    assert.deepEqual(view?.rows, []);
    assert.match(
      view?.warnings.join(" ") ?? "",
      /No clear conviction-versus-momentum divergence was found/i,
    );
    assertNoForbiddenPublicKeys(view);
  } finally {
    restore();
  }
});

test("sector divergence capability returns partial when forward overlay is unavailable", async () => {
  const restore = configureExternalPgForTest();
  try {
    const result = await buildSectorDivergenceView(
      {
        classification,
        message: "Which sectors have strong evidence but poor momentum?",
        snapshots: {},
        toolOutputs: {},
      },
      {
        queryRunner: async () => [
          {
            sector: "Healthcare",
            rank: 1,
            conviction_score_pct: 66,
            conviction_bucket: "CONSTRUCTIVE",
            momentum_score_pct: 55,
            momentum_bucket: "MIXED",
            divergence_type: "conviction_but_weak_price_action",
            evidence_strength: "WEAK",
            as_of_date: "2026-05-01",
            overlay_available: false,
          },
        ],
      },
    );

    const view = result.views.sectorDivergenceView;
    assert.equal(view?.state, "partial");
    assert.equal(view?.rows[0]?.hitRatePct, undefined);
    assert.match(view?.warnings.join(" ") ?? "", /overlay is unavailable/i);
    assertNoForbiddenPublicKeys(view);
  } finally {
    restore();
  }
});

test("sector divergence capability returns unavailable when source has no rows", async () => {
  const restore = configureExternalPgForTest();
  try {
    const result = await buildSectorDivergenceView(
      {
        classification,
        message: "Where is there divergence between conviction and momentum?",
        snapshots: {},
        toolOutputs: {},
      },
      { queryRunner: async () => [] },
    );

    const view = result.views.sectorDivergenceView;
    assert.equal(view?.state, "unavailable");
    assert.equal(view?.rows.length, 0);
    assert.match(view?.warnings.join(" ") ?? "", /No sector divergence rows/i);
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
  assert.doesNotMatch(json, /divergence_score_pct/);
  assert.doesNotMatch(json, /divergenceScorePct/);
  assert.doesNotMatch(json, /score_formula/);
  assert.doesNotMatch(json, /feature_rules/);
}
