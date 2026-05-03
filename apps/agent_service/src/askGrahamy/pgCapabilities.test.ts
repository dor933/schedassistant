import test from "node:test";
import assert from "node:assert/strict";
import { buildSectorConvictionLeaderboardView } from "./pgCapabilities/sectorConvictionLeaderboard";
import { buildStockIdeaDiscoveryView } from "./pgCapabilities/stockIdeaDiscovery";
import { capabilityForIntent } from "./pgCapabilities/registry";
import { assessCapabilityFreshness } from "./pgCapabilities/freshnessGuard";
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
  assert.deepEqual(view.freshness, {
    dataThrough: "2026-05-01",
    state: "fresh",
  });
  assertNoForbiddenPublicKeys(view);
});

test("FreshnessGuard treats Friday data as fresh on Sunday", () => {
  const assessment = assessCapabilityFreshness({
    capability: "stock_idea_discovery",
    dataThrough: "2026-05-01",
    now: new Date("2026-05-03T12:00:00Z"),
    sources: [
      {
        sourceId: "features_daily",
        tableOrView: "md_features_daily",
        required: true,
        refreshState: "FRESH",
        lastSuccessAt: "2026-05-03T12:30:00Z",
      },
    ],
  });

  assert.equal(assessment.decision, "allow");
  assert.equal(assessment.publicFreshness.state, "fresh");
  assert.equal(assessment.publicFreshness.dataThrough, "2026-05-01");
  assert.equal(assessment.publicFreshness.warning, undefined);
});

test("FreshnessGuard returns public stale warning without source names", () => {
  const assessment = assessCapabilityFreshness({
    capability: "sector_conviction_leaderboard",
    dataThrough: "2026-04-30",
    now: new Date("2026-05-03T12:00:00Z"),
    sources: [
      {
        sourceId: "sector_peer_daily",
        tableOrView: "md_research_sector_peer_daily",
        required: true,
        refreshState: "STALE",
        lastSuccessAt: "2026-05-01T12:30:00Z",
        maxAge: "28:00:00",
      },
    ],
  });

  assert.equal(assessment.decision, "allow_with_caveat");
  assert.equal(assessment.publicFreshness.state, "stale");
  assert.match(assessment.publicFreshness.warning ?? "", /data through 2026-04-30/i);
  assertNoFreshnessInternals(assessment.publicFreshness);
  assert.match(JSON.stringify(assessment.internalDiagnostics), /md_research_sector_peer_daily/);
});

test("FreshnessGuard marks missing dataThrough as unknown", () => {
  const assessment = assessCapabilityFreshness({
    capability: "stock_idea_discovery",
    now: new Date("2026-05-03T12:00:00Z"),
    sources: [
      {
        sourceId: "features_daily",
        tableOrView: "md_features_daily",
        required: true,
        refreshState: "FRESH",
      },
    ],
  });

  assert.equal(assessment.decision, "allow_with_caveat");
  assert.equal(assessment.reasonCode, "missing_data_through");
  assert.deepEqual(assessment.publicFreshness, {
    state: "unknown",
    warning: "Freshness could not be verified for this view.",
  });
});

test("FreshnessGuard marks hard-stale primary data unavailable", () => {
  const assessment = assessCapabilityFreshness({
    capability: "stock_idea_discovery",
    dataThrough: "2026-04-20",
    now: new Date("2026-05-03T12:00:00Z"),
    sources: [
      {
        sourceId: "features_daily",
        tableOrView: "md_features_daily",
        required: true,
        refreshState: "FRESH",
      },
    ],
  });

  assert.equal(assessment.decision, "unavailable");
  assert.equal(assessment.reasonCode, "hard_stale");
  assert.equal(assessment.publicFreshness.state, "stale");
  assert.match(assessment.publicFreshness.warning ?? "", /current ranking is unavailable/i);
});

test("PG capability registry routes stock idea discovery intent", () => {
  const entry = capabilityForIntent("stock_idea_discovery");
  assert.ok(entry);
  assert.equal(entry.name, "stock_idea_discovery");
  assert.equal(entry.queryName, "query_stock_idea_discovery");
  assert.deepEqual(entry.requiredParams, []);
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
  assert.equal(view.freshness.state, "unknown");
  assert.match(view.freshness.warning ?? "", /Freshness could not be verified/i);
  assertNoFreshnessInternals(view.freshness);
});

test("sector conviction leaderboard returns unavailable for hard-stale primary source", async () => {
  const result = await buildSectorConvictionLeaderboardView(
    {
      classification: leaderboardClassification,
      message: "Which sectors are leading on conviction this week?",
      snapshots: {},
      toolOutputs: {},
    },
    {
      now: new Date("2026-05-03T12:00:00Z"),
      queryRunner: async () => [
        {
          sector: "Utilities",
          rank: 1,
          conviction_score_pct: 70,
          conviction_bucket: "CONSTRUCTIVE",
          evidence_strength: "WEAK",
          as_of_date: "2026-04-20",
          peer_freshness_state: "FRESH",
          peer_completed_at: "2026-04-20T12:31:04Z",
          overlay_available: false,
        },
      ],
    },
  );

  const view = result.views.sectorLeaderboardView;
  assert.ok(view);
  assert.equal(view.state, "unavailable");
  assert.deepEqual(view.rows, []);
  assert.equal(view.freshness.state, "stale");
  assert.match(view.freshness.warning ?? "", /stale data through 2026-04-20/i);
  assertNoForbiddenPublicKeys(view);
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

test("stock idea discovery returns partial public view with bounded forward overlay", async () => {
  let replacements: Record<string, unknown> = {};
  const result = await buildStockIdeaDiscoveryView(
    {
      classification: stockIdeaClassification,
      message: "Show me top conviction names today",
      snapshots: {},
      toolOutputs: {},
    },
    {
      maxRows: 50,
      candidatePoolSize: 1000,
      queryRunner: async (params) => {
        replacements = params;
        return [
          {
            symbol: "GSL",
            company_name: "Global Ship Lease, Inc.",
            sector: "Industrials",
            rank: 1,
            conviction_score_pct: 84.42,
            conviction_bucket: "HIGH",
            evidence_strength: "ADEQUATE",
            hit_rate_pct: 61.23,
            median_return_pct: 5.241,
            p25_return_pct: -8.11,
            p75_return_pct: 26.46,
            momentum_bucket: "STRONG",
            quality_bucket: "CONSTRUCTIVE",
            valuation_bucket: "ATTRACTIVE",
            path_risk_bucket: "Numeric daily path-risk is unavailable in V1.",
            as_of_date: "2026-05-01",
            features_freshness_state: "FRESH",
            features_completed_at: "2026-05-02T12:30:04Z",
            peer_freshness_state: "FRESH",
            peer_completed_at: "2026-05-02T12:31:04Z",
            forward_overlay_available: true,
            setup_score: 91.2,
            raw_sql: "must-not-leak",
            feature_rules: "must-not-leak",
          },
        ];
      },
    },
  );

  assert.equal(replacements.MAX_ROWS, 20);
  assert.equal(replacements.CANDIDATE_POOL_SIZE, 500);
  assert.equal(replacements.RANK_BY, "conviction");
  const view = result.views.stockIdeaView;
  assert.ok(view);
  assert.equal(view.state, "partial");
  assert.equal(view.source, "pg_features_daily");
  assert.equal(view.asOfDate, "2026-05-01");
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0].symbol, "GSL");
  assert.equal(view.rows[0].convictionScorePct, 84.4);
  assert.equal(view.rows[0].hitRatePct, 61.2);
  assert.equal(view.rows[0].medianReturnPct, 5.24);
  assert.equal(view.rows[0].p10MaxDrawdownPct, undefined);
  assert.equal(view.rows[0].recoveredByHorizonRatePct, undefined);
  assert.deepEqual(view.freshness, {
    dataThrough: "2026-05-01",
    state: "fresh",
  });
  assert.match(view.warnings.join(" "), /research candidates/i);
  assertNoForbiddenPublicKeys(view);
});

test("stock idea discovery returns unavailable when source has no rows", async () => {
  const result = await buildStockIdeaDiscoveryView(
    {
      classification: stockIdeaClassification,
      message: "Give me an interesting stock",
      snapshots: {},
      toolOutputs: {},
    },
    { queryRunner: async () => [] },
  );

  const view = result.views.stockIdeaView;
  assert.ok(view);
  assert.equal(view.state, "unavailable");
  assert.deepEqual(view.rows, []);
  assert.match(view.warnings.join(" "), /No stock idea discovery rows/i);
});

test("stock idea discovery returns unavailable when external PG is not configured", async () => {
  const previousHost = process.env.EXTERNAL_PG_HOST;
  const previousDb = process.env.EXTERNAL_PG_DATABASE;
  delete process.env.EXTERNAL_PG_HOST;
  delete process.env.EXTERNAL_PG_DATABASE;

  try {
    const result = await buildStockIdeaDiscoveryView({
      classification: stockIdeaClassification,
      message: "What stock looks interesting today?",
      snapshots: {},
      toolOutputs: {},
    });
    const view = result.views.stockIdeaView;
    assert.ok(view);
    assert.equal(view.state, "unavailable");
    assert.deepEqual(view.rows, []);
    assert.match(view.warnings.join(" "), /not configured/i);
  } finally {
    if (previousHost == null) delete process.env.EXTERNAL_PG_HOST;
    else process.env.EXTERNAL_PG_HOST = previousHost;
    if (previousDb == null) delete process.env.EXTERNAL_PG_DATABASE;
    else process.env.EXTERNAL_PG_DATABASE = previousDb;
  }
});

test("publicResearchView carries stockIdeaView without Research Objects", async () => {
  const result = await buildStockIdeaDiscoveryView(
    {
      classification: stockIdeaClassification,
      message: "Give me an interesting stock",
      snapshots: {},
      toolOutputs: {},
    },
    {
      queryRunner: async () => [
        {
          symbol: "GSL",
          company_name: "Global Ship Lease, Inc.",
          sector: "Industrials",
          rank: 1,
          conviction_score_pct: 80,
          conviction_bucket: "HIGH",
          evidence_strength: "CURRENT_ONLY",
          momentum_bucket: "STRONG",
          quality_bucket: "CONSTRUCTIVE",
          valuation_bucket: "ATTRACTIVE",
          path_risk_bucket: "Numeric daily path-risk is unavailable in V1.",
          as_of_date: "2026-05-01",
          forward_overlay_available: false,
        },
      ],
    },
  );

  const publicView = compilePublicResearchView({
    classification: stockIdeaClassification,
    snapshots: { freshness: { dataThrough: "2026-05-01" } },
    toolOutputs: {},
    researchObjects: [],
    pgCapabilityViews: result.views,
    warnings: [],
  });

  assert.equal(publicView.objectType, "stock");
  assert.equal(publicView.researchObjectViews.length, 0);
  assert.deepEqual(publicView.researchObjectKeys, []);
  assert.equal(publicView.stockIdeaView?.rows[0].symbol, "GSL");
  assertNoForbiddenPublicKeys(publicView);
});

test("stock idea discovery public freshness is unknown when dataThrough is missing", async () => {
  const result = await buildStockIdeaDiscoveryView(
    {
      classification: stockIdeaClassification,
      message: "What stock looks interesting today?",
      snapshots: {},
      toolOutputs: {},
    },
    {
      queryRunner: async () => [
        {
          symbol: "GSL",
          company_name: "Global Ship Lease, Inc.",
          sector: "Industrials",
          rank: 1,
          conviction_score_pct: 80,
          conviction_bucket: "HIGH",
          features_freshness_state: "FRESH",
          peer_freshness_state: "FRESH",
          forward_overlay_available: false,
        },
      ],
    },
  );

  const view = result.views.stockIdeaView;
  assert.ok(view);
  assert.equal(view.state, "partial");
  assert.equal(view.freshness.state, "unknown");
  assert.match(view.freshness.warning ?? "", /Freshness could not be verified/i);
  assertNoForbiddenPublicKeys(view);
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
  assert.doesNotMatch(json, /setup_score/);
  assert.doesNotMatch(json, /feature_rules/);
  assertNoFreshnessInternals(value);
}

function assertNoFreshnessInternals(value: unknown): void {
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /md_research_refresh_latest/);
  assert.doesNotMatch(json, /md_research_refresh_stale/);
  assert.doesNotMatch(json, /md_features_daily/);
  assert.doesNotMatch(json, /md_research_sector_peer_daily/);
  assert.doesNotMatch(json, /pipeline_state/);
  assert.doesNotMatch(json, /run_id/);
  assert.doesNotMatch(json, /stage/);
  assert.doesNotMatch(json, /last_success_at/);
  assert.doesNotMatch(json, /completed_at/);
  assert.doesNotMatch(json, /max_age/);
  assert.doesNotMatch(json, /refresh logs/);
}
