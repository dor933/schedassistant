import test from "node:test";
import assert from "node:assert/strict";
import { buildSectorConvictionLeaderboardView } from "./pgCapabilities/sectorConvictionLeaderboard";
import { buildSectorDeltaView } from "./pgCapabilities/sectorDelta";
import { buildSectorDivergenceView } from "./pgCapabilities/sectorDivergence";
import { buildStockIdeaDiscoveryView } from "./pgCapabilities/stockIdeaDiscovery";
import { buildStockVsSectorComparisonView } from "./pgCapabilities/stockVsSectorComparison";
import {
  buildCapabilityCacheKey,
  capabilityForClassification,
  capabilityForIntent,
  executePgCapabilitiesWithCache,
} from "./pgCapabilities/registry";
import type { CachedCapabilityView } from "./pgCapabilities/types";
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

const sectorDeltaClassification: Classification = {
  intent: "week_over_week_sector_delta",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

const comparisonClassification: Classification = {
  intent: "comparison",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  comparison: {
    comparisonType: "stock_vs_sector",
    left: { type: "stock", symbol: "GSL" },
    right: { type: "implicit_stock_sector" },
  },
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

test("PG capability registry routes sector divergence intent", () => {
  const entry = capabilityForIntent("sector_momentum_vs_conviction_divergence");
  assert.ok(entry);
  assert.equal(entry.name, "sector_momentum_vs_conviction_divergence");
  assert.equal(entry.queryName, "query_sector_divergence");
  assert.deepEqual(entry.requiredParams, []);
});

test("PG capability registry routes week-over-week sector delta intent", () => {
  const entry = capabilityForIntent("week_over_week_sector_delta");
  assert.ok(entry);
  assert.equal(entry.name, "week_over_week_sector_delta");
  assert.equal(entry.queryName, "query_sector_delta");
  assert.equal(entry.source, "pg_sector_weekly_history");
  assert.deepEqual(entry.requiredParams, []);
});

test("PG capability registry routes comparison intent to stock-vs-sector capability", () => {
  const entry = capabilityForIntent("comparison");
  assert.ok(entry);
  assert.equal(entry.name, "stock_vs_sector_comparison");
  assert.equal(entry.queryName, "query_stock_vs_sector_comparison");
  assert.equal(entry.source, "pg_current_features");
  assert.deepEqual(entry.requiredParams, ["comparison.left.symbol"]);
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

test("sector divergence returns complete public view with optional overlay", async () => {
  let replacements: Record<string, unknown> = {};
  const result = await buildSectorDivergenceView(
    {
      classification: divergenceClassification,
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
  assert.ok(view);
  assert.equal(view.state, "complete");
  assert.equal(view.source, "pg_sector_peer_daily");
  assert.equal(view.asOfDate, "2026-05-01");
  assert.equal(view.evaluatedSectorCount, 2);
  assert.equal(view.clearDivergenceCount, 1);
  assert.equal(view.rows.length, 1);
  assert.deepEqual(view.rows[0], {
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
  assert.deepEqual(view.freshness, {
    dataThrough: "2026-05-01",
    state: "fresh",
  });
  assertNoForbiddenPublicKeys(view);
});

test("sector divergence returns complete empty view when no clear divergence exists", async () => {
  const result = await buildSectorDivergenceView(
    {
      classification: divergenceClassification,
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
        {
          sector: "Technology",
          rank: 2,
          conviction_score_pct: 50,
          conviction_bucket: "MIXED",
          momentum_score_pct: 90,
          momentum_bucket: "STRONG",
          divergence_type: "in_line",
          evidence_strength: "ROBUST",
          hit_rate_pct: 54.2,
          as_of_date: "2026-05-01",
          overlay_available: true,
          evaluated_sector_count: 10,
          clear_divergence_count: 0,
        },
      ],
    },
  );

  const view = result.views.sectorDivergenceView;
  assert.ok(view);
  assert.equal(view.state, "complete");
  assert.equal(view.evaluatedSectorCount, 10);
  assert.equal(view.clearDivergenceCount, 0);
  assert.deepEqual(view.rows, []);
  assert.match(
    view.warnings.join(" "),
    /No clear conviction-versus-momentum divergence was found/i,
  );
  assertNoForbiddenPublicKeys(view);
});

test("sector divergence returns partial when forward overlay is absent", async () => {
  const result = await buildSectorDivergenceView(
    {
      classification: divergenceClassification,
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
  assert.ok(view);
  assert.equal(view.state, "partial");
  assert.equal(view.rows[0].hitRatePct, undefined);
  assert.match(view.warnings.join(" "), /overlay is unavailable/i);
  assert.equal(view.freshness.state, "unknown");
  assertNoForbiddenPublicKeys(view);
});

test("sector divergence returns unavailable for hard-stale primary source", async () => {
  const result = await buildSectorDivergenceView(
    {
      classification: divergenceClassification,
      message: "Which sectors have conviction but weak price action?",
      snapshots: {},
      toolOutputs: {},
    },
    {
      now: new Date("2026-05-03T12:00:00Z"),
      queryRunner: async () => [
        {
          sector: "Healthcare",
          rank: 1,
          conviction_score_pct: 66,
          conviction_bucket: "CONSTRUCTIVE",
          momentum_score_pct: 55,
          momentum_bucket: "MIXED",
          divergence_type: "conviction_but_weak_price_action",
          as_of_date: "2026-04-20",
          peer_freshness_state: "FRESH",
          peer_completed_at: "2026-04-20T12:31:04Z",
          overlay_available: false,
        },
      ],
    },
  );

  const view = result.views.sectorDivergenceView;
  assert.ok(view);
  assert.equal(view.state, "unavailable");
  assert.deepEqual(view.rows, []);
  assert.equal(view.freshness.state, "stale");
  assert.match(view.freshness.warning ?? "", /stale data through 2026-04-20/i);
  assertNoForbiddenPublicKeys(view);
});

test("sector divergence returns unavailable when source has no rows", async () => {
  const result = await buildSectorDivergenceView(
    {
      classification: divergenceClassification,
      message: "Where is there divergence between conviction and momentum?",
      snapshots: {},
      toolOutputs: {},
    },
    { queryRunner: async () => [] },
  );

  const view = result.views.sectorDivergenceView;
  assert.ok(view);
  assert.equal(view.state, "unavailable");
  assert.deepEqual(view.rows, []);
  assert.match(view.warnings.join(" "), /No sector divergence rows/i);
});

test("publicResearchView carries sectorDivergenceView without Research Objects", async () => {
  const result = await buildSectorDivergenceView(
    {
      classification: divergenceClassification,
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
          momentum_score_pct: 30,
          momentum_bucket: "WEAK",
          divergence_type: "conviction_but_weak_price_action",
          evidence_strength: "ADEQUATE",
          hit_rate_pct: 58.2,
          as_of_date: "2026-05-01",
          overlay_available: true,
        },
      ],
    },
  );

  const publicView = compilePublicResearchView({
    classification: divergenceClassification,
    snapshots: { freshness: { dataThrough: "2026-05-01" } },
    toolOutputs: {},
    researchObjects: [],
    pgCapabilityViews: result.views,
    warnings: [],
  });

  assert.equal(publicView.objectType, "sector");
  assert.equal(publicView.researchObjectViews.length, 0);
  assert.deepEqual(publicView.researchObjectKeys, []);
  assert.equal(publicView.sectorDivergenceView?.rows[0].sector, "Utilities");
  assert.equal(publicView.evidence.sectorDivergenceRows, 1);
  assertNoForbiddenPublicKeys(publicView);
});

test("sector weekly delta returns complete improvement view with current and prior dates", async () => {
  let replacements: Record<string, unknown> = {};
  const result = await buildSectorDeltaView(
    {
      classification: sectorDeltaClassification,
      message: "Which sectors improved most versus last week?",
      snapshots: {},
      toolOutputs: {},
    },
    {
      maxRows: 50,
      now: new Date("2026-04-29T12:00:00Z"),
      queryRunner: async (params) => {
        replacements = params;
        return [
          {
            sector: "Technology",
            rank: 1,
            current_conviction_score_pct: 76.24,
            prior_conviction_score_pct: 68.12,
            conviction_delta_pct: 8.12,
            current_conviction_bucket: "HIGH",
            prior_conviction_bucket: "CONSTRUCTIVE",
            current_momentum_bucket: "STRONG",
            prior_momentum_bucket: "MIXED",
            momentum_delta_pct: 5.64,
            direction: "improved",
            include_in_public: true,
            current_as_of_date: "2026-04-27",
            prior_as_of_date: "2026-04-20",
            weekly_freshness_state: "FRESH",
            weekly_completed_at: "2026-04-28T12:30:04Z",
            evaluated_sector_count: 11,
            meaningful_delta_count: 1,
            sector_delta_formula: "must-not-leak",
            raw_sql: "must-not-leak",
          },
        ];
      },
    },
  );

  assert.equal(replacements.MAX_ROWS, 20);
  assert.equal(replacements.RANK_BY, "overall_change");
  assert.equal(replacements.DIRECTION_FILTER, "improved");
  const view = result.views.sectorDeltaView;
  assert.ok(view);
  assert.equal(view.state, "complete");
  assert.equal(view.source, "pg_sector_weekly_history");
  assert.equal(view.currentAsOfDate, "2026-04-27");
  assert.equal(view.priorAsOfDate, "2026-04-20");
  assert.equal(view.rankingBasis, "overall_change");
  assert.equal(view.rows.length, 1);
  assert.deepEqual(view.rows[0], {
    sector: "Technology",
    rank: 1,
    currentConvictionScorePct: 76.2,
    priorConvictionScorePct: 68.1,
    convictionDeltaPct: 8.1,
    currentConvictionBucket: "HIGH",
    priorConvictionBucket: "CONSTRUCTIVE",
    currentMomentumBucket: "STRONG",
    priorMomentumBucket: "MIXED",
    momentumDeltaPct: 5.6,
    direction: "improved",
    interpretationBullets: [
      "Weekly conviction proxy improved by 8.1 points.",
      "Weekly price momentum improved by 5.6 points.",
      "Conviction bucket moved from CONSTRUCTIVE to HIGH.",
      "Momentum bucket moved from MIXED to STRONG.",
    ],
  });
  assert.deepEqual(view.freshness, {
    dataThrough: "2026-04-27",
    state: "fresh",
  });
  assertNoForbiddenPublicKeys(view);
});

test("sector weekly delta returns only deterioration rows for deterioration prompts", async () => {
  const result = await buildSectorDeltaView(
    {
      classification: sectorDeltaClassification,
      message: "Which sectors deteriorated versus last week?",
      snapshots: {},
      toolOutputs: {},
    },
    {
      queryRunner: async () => [
        {
          sector: "Energy",
          rank: 1,
          current_conviction_score_pct: 42,
          prior_conviction_score_pct: 60,
          conviction_delta_pct: -18,
          current_conviction_bucket: "WEAK",
          prior_conviction_bucket: "CONSTRUCTIVE",
          current_momentum_bucket: "WEAK",
          prior_momentum_bucket: "MIXED",
          momentum_delta_pct: -10,
          direction: "deteriorated",
          include_in_public: true,
          current_as_of_date: "2026-04-27",
          prior_as_of_date: "2026-04-20",
          weekly_freshness_state: "FRESH",
          weekly_completed_at: "2026-04-28T12:30:04Z",
        },
        {
          sector: "Technology",
          rank: 2,
          conviction_delta_pct: 8,
          momentum_delta_pct: 4,
          direction: "improved",
          include_in_public: false,
          current_as_of_date: "2026-04-27",
          prior_as_of_date: "2026-04-20",
        },
      ],
    },
  );

  const view = result.views.sectorDeltaView;
  assert.ok(view);
  assert.equal(view.rankingBasis, "deterioration");
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0].sector, "Energy");
  assert.equal(view.rows[0].direction, "deteriorated");
  assertNoForbiddenPublicKeys(view);
});

test("sector weekly delta returns unavailable when prior baseline is missing", async () => {
  const result = await buildSectorDeltaView(
    {
      classification: sectorDeltaClassification,
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
  assert.match(view.warnings.join(" "), /prior weekly sector baseline is missing/i);
  assertNoForbiddenPublicKeys(view);
});

test("sector weekly delta returns complete empty view when no meaningful delta exists", async () => {
  const result = await buildSectorDeltaView(
    {
      classification: sectorDeltaClassification,
      message: "What changed since last week?",
      snapshots: {},
      toolOutputs: {},
    },
    {
      queryRunner: async () => [
        {
          sector: "Utilities",
          rank: 1,
          current_conviction_score_pct: 50,
          prior_conviction_score_pct: 49,
          conviction_delta_pct: 1,
          current_conviction_bucket: "MIXED",
          prior_conviction_bucket: "MIXED",
          current_momentum_bucket: "MIXED",
          prior_momentum_bucket: "MIXED",
          momentum_delta_pct: 0.5,
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

test("publicResearchView carries sectorDeltaView without Research Objects", async () => {
  const result = await buildSectorDeltaView(
    {
      classification: sectorDeltaClassification,
      message: "Which sectors improved most versus last week?",
      snapshots: {},
      toolOutputs: {},
    },
    {
      queryRunner: async () => [
        {
          sector: "Technology",
          rank: 1,
          current_conviction_score_pct: 76,
          prior_conviction_score_pct: 68,
          conviction_delta_pct: 8,
          current_conviction_bucket: "HIGH",
          prior_conviction_bucket: "CONSTRUCTIVE",
          current_momentum_bucket: "STRONG",
          prior_momentum_bucket: "MIXED",
          momentum_delta_pct: 5,
          direction: "improved",
          include_in_public: true,
          current_as_of_date: "2026-04-27",
          prior_as_of_date: "2026-04-20",
          weekly_freshness_state: "FRESH",
          weekly_completed_at: "2026-04-28T12:30:04Z",
        },
      ],
    },
  );

  const publicView = compilePublicResearchView({
    classification: sectorDeltaClassification,
    snapshots: { freshness: { dataThrough: "2026-04-27" } },
    toolOutputs: {},
    researchObjects: [],
    pgCapabilityViews: result.views,
    warnings: [],
  });

  assert.equal(publicView.objectType, "sector");
  assert.equal(publicView.researchObjectViews.length, 0);
  assert.deepEqual(publicView.researchObjectKeys, []);
  assert.equal(publicView.sectorDeltaView?.rows[0].sector, "Technology");
  assert.equal(publicView.evidence.sectorDeltaRows, 1);
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

test("stock-vs-sector comparison returns partial public view with safe deltas", async () => {
  let replacements: Record<string, unknown> = {};
  const result = await buildStockVsSectorComparisonView(
    {
      classification: comparisonClassification,
      message: "Compare GSL to its sector",
      snapshots: {},
      toolOutputs: {},
    },
    {
      queryRunner: async (params) => {
        replacements = params;
        return [
          {
            symbol: "GSL",
            company_name: "Global Ship Lease, Inc.",
            stock_sector: "Industrials",
            resolved_sector: "Industrials",
            comparison_sector_found: true,
            as_of_date: "2026-05-01",
            stock_conviction_score_pct: 81.78,
            stock_conviction_bucket: "HIGH",
            stock_valuation_bucket: "ATTRACTIVE",
            stock_momentum_bucket: "STRONG",
            stock_quality_bucket: "CONSTRUCTIVE",
            stock_growth_bucket: "CONSTRUCTIVE",
            stock_leverage_bucket: "CONSTRUCTIVE",
            stock_hit_rate_pct: 61.23,
            stock_median_return_pct: 5.24,
            sector_conviction_score_pct: 55.44,
            sector_conviction_bucket: "MIXED",
            sector_momentum_bucket: "MIXED",
            sector_quality_bucket: "MIXED",
            sector_growth_bucket: "MIXED",
            sector_leverage_bucket: "CONSTRUCTIVE",
            sector_hit_rate_pct: 54.1,
            features_freshness_state: "FRESH",
            features_completed_at: "2026-05-02T12:30:04Z",
            peer_freshness_state: "FRESH",
            peer_completed_at: "2026-05-02T12:31:04Z",
            forward_freshness_state: "FRESH",
            forward_completed_at: "2026-05-02T12:32:04Z",
            stock_forward_overlay_available: true,
            sector_forward_overlay_available: true,
            raw_sql: "must-not-leak",
            comparison_formula: "must-not-leak",
            setup_score: 99,
          },
        ];
      },
    },
  );

  assert.equal(replacements.SYMBOL, "GSL");
  assert.equal(replacements.SECTOR, "");
  const view = result.views.comparisonView;
  assert.ok(view);
  assert.equal(view.state, "partial");
  assert.equal(view.comparisonType, "stock_vs_sector");
  assert.equal(view.asOfDate, "2026-05-01");
  assert.equal(view.left.symbol, "GSL");
  assert.equal(view.right.sector, "Industrials");
  assert.equal(view.left.metrics.convictionScorePct, 81.8);
  assert.equal(view.right.metrics.convictionScorePct, 55.4);
  assert.equal(view.deltas[0].metric, "conviction");
  assert.equal(view.deltas[0].interpretationBucket, "left_stronger");
  assert.match(view.summaryBullets.join(" "), /GSL screens stronger/i);
  assert.match(view.warnings.join(" "), /path-risk comparison is unavailable/i);
  assert.deepEqual(view.freshness, {
    dataThrough: "2026-05-01",
    state: "fresh",
  });
  assertNoForbiddenPublicKeys(view);
});

test("stock-vs-sector comparison returns unavailable for explicit invalid sector", async () => {
  const result = await buildStockVsSectorComparisonView(
    {
      classification: {
        ...comparisonClassification,
        comparison: {
          comparisonType: "stock_vs_sector",
          left: { type: "stock", symbol: "GSL" },
          right: { type: "sector", sector: "Crypto Miners" },
        },
      },
      message: "How does GSL look versus Crypto Miners?",
      snapshots: {},
      toolOutputs: {},
    },
    {
      queryRunner: async () => {
        throw new Error("should not query invalid sectors");
      },
    },
  );

  const view = result.views.comparisonView;
  assert.ok(view);
  assert.equal(view.state, "unavailable");
  assert.deepEqual(view.deltas, []);
  assert.match(view.warnings.join(" "), /not supported/i);
  assertNoForbiddenPublicKeys(view);
});

test("stock-vs-sector comparison returns unavailable when stock row is missing", async () => {
  const result = await buildStockVsSectorComparisonView(
    {
      classification: comparisonClassification,
      message: "Compare GSL to its sector",
      snapshots: {},
      toolOutputs: {},
    },
    { queryRunner: async () => [] },
  );

  const view = result.views.comparisonView;
  assert.ok(view);
  assert.equal(view.state, "unavailable");
  assert.match(view.warnings.join(" "), /No current PG feature row/i);
});

test("stock-vs-sector comparison returns unavailable when implicit sector cannot resolve", async () => {
  const result = await buildStockVsSectorComparisonView(
    {
      classification: comparisonClassification,
      message: "Is GSL better than its sector?",
      snapshots: {},
      toolOutputs: {},
    },
    {
      queryRunner: async () => [
        {
          symbol: "GSL",
          company_name: "Global Ship Lease, Inc.",
          comparison_sector_found: false,
          as_of_date: "2026-05-01",
        },
      ],
    },
  );

  const view = result.views.comparisonView;
  assert.ok(view);
  assert.equal(view.state, "unavailable");
  assert.match(view.warnings.join(" "), /does not include a sector/i);
});

test("stock-vs-sector comparison uses explicit canonical sector parameter", async () => {
  let replacements: Record<string, unknown> = {};
  await buildStockVsSectorComparisonView(
    {
      classification: {
        ...comparisonClassification,
        comparison: {
          comparisonType: "stock_vs_sector",
          left: { type: "stock", symbol: "GSL" },
          right: { type: "sector", sector: "financial services" },
        },
      },
      message: "How does GSL look versus Financial Services?",
      snapshots: {},
      toolOutputs: {},
    },
    {
      queryRunner: async (params) => {
        replacements = params;
        return [];
      },
    },
  );

  assert.equal(replacements.SYMBOL, "GSL");
  assert.equal(replacements.SECTOR, "Financial Services");
});

test("publicResearchView carries comparisonView without Research Objects", async () => {
  const result = await buildStockVsSectorComparisonView(
    {
      classification: comparisonClassification,
      message: "Compare GSL to its sector",
      snapshots: {},
      toolOutputs: {},
    },
    {
      queryRunner: async () => [
        {
          symbol: "GSL",
          company_name: "Global Ship Lease, Inc.",
          stock_sector: "Industrials",
          resolved_sector: "Industrials",
          comparison_sector_found: true,
          as_of_date: "2026-05-01",
          stock_conviction_score_pct: 82,
          stock_conviction_bucket: "HIGH",
          stock_momentum_bucket: "STRONG",
          sector_conviction_score_pct: 55,
          sector_conviction_bucket: "MIXED",
          sector_momentum_bucket: "MIXED",
          features_freshness_state: "FRESH",
          peer_freshness_state: "FRESH",
        },
      ],
    },
  );

  const publicView = compilePublicResearchView({
    classification: comparisonClassification,
    snapshots: { freshness: { dataThrough: "2026-05-01" } },
    toolOutputs: {},
    researchObjects: [],
    pgCapabilityViews: result.views,
    warnings: [],
  });

  assert.equal(publicView.objectType, "mixed");
  assert.equal(publicView.researchObjectViews.length, 0);
  assert.deepEqual(publicView.researchObjectKeys, []);
  assert.equal(publicView.comparisonView?.left.symbol, "GSL");
  assert.equal(publicView.evidence.comparisonType, "stock_vs_sector");
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

test("executePgCapabilitiesWithCache returns empty result for non-capability intent", async () => {
  const result = await executePgCapabilitiesWithCache(
    {
      classification: {
        ...leaderboardClassification,
        intent: "stock_sector_regime",
      },
      message: "Tell me about MSFT",
      snapshots: { freshness: { dataThrough: "2026-05-01" } },
      toolOutputs: {},
    },
    [],
  );
  assert.deepEqual(result.views, {});
  assert.deepEqual(result.viewsUpdated, []);
  assert.deepEqual(result.cacheStats, { hits: 0, misses: 0, writes: 0 });
});

test("executePgCapabilitiesWithCache returns cache hit when prior key matches", async () => {
  const asOfDate = "2026-05-01";
  const cacheKey = buildCapabilityCacheKey(
    "sector_conviction_leaderboard",
    { rankingBasis: "conviction" },
    asOfDate,
  );
  const cachedView = {
    viewSchemaVersion: 1,
    state: "complete" as const,
    source: "pg_sector_peer_daily" as const,
    period: "latest" as const,
    rankingBasis: "conviction" as const,
    asOfDate,
    rows: [{ sector: "Industrials", rank: 1, convictionScorePct: 80 }],
    freshness: { dataThrough: asOfDate, state: "fresh" as const },
    warnings: [],
  };
  const prior: CachedCapabilityView = {
    cacheKey,
    capabilityName: "sector_conviction_leaderboard",
    viewSchemaVersion: 1,
    asOfDate,
    view: cachedView,
    generatedAt: "2026-05-01T18:00:00Z",
  };

  let runnerCalled = false;
  const result = await executePgCapabilitiesWithCache(
    {
      classification: leaderboardClassification,
      message: "Which sectors are leading on conviction this week?",
      snapshots: { freshness: { dataThrough: asOfDate } },
      toolOutputs: {},
    },
    [prior],
    async () => {
      runnerCalled = true;
      return { views: {}, warnings: [] };
    },
  );

  assert.equal(runnerCalled, false);
  assert.equal(result.views.sectorLeaderboardView, cachedView);
  assert.deepEqual(result.viewsUpdated, []);
  assert.deepEqual(result.cacheStats, { hits: 1, misses: 0, writes: 0 });
});

test("executePgCapabilitiesWithCache miss runs runner and emits viewsUpdated", async () => {
  const asOfDate = "2026-05-01";
  const result = await executePgCapabilitiesWithCache(
    {
      classification: leaderboardClassification,
      message: "Which sectors are leading on conviction this week?",
      snapshots: { freshness: { dataThrough: asOfDate } },
      toolOutputs: {},
    },
    [],
    async () => ({
      views: {
        sectorLeaderboardView: {
          viewSchemaVersion: 1,
          state: "complete",
          source: "pg_sector_peer_daily",
          period: "latest",
          rankingBasis: "conviction",
          asOfDate,
          rows: [{ sector: "Technology", rank: 1, convictionScorePct: 85 }],
          freshness: { dataThrough: asOfDate, state: "fresh" },
          warnings: [],
        },
      },
      warnings: [],
    }),
  );

  assert.equal(result.viewsUpdated.length, 1);
  const updated = result.viewsUpdated[0];
  assert.equal(updated.capabilityName, "sector_conviction_leaderboard");
  assert.equal(updated.cacheKey, buildCapabilityCacheKey(
    "sector_conviction_leaderboard",
    { rankingBasis: "conviction" },
    asOfDate,
  ));
  assert.equal(updated.viewSchemaVersion, 1);
  assert.equal(updated.asOfDate, asOfDate);
  assert.deepEqual(result.cacheStats, { hits: 0, misses: 1, writes: 1 });
});

test("executePgCapabilitiesWithCache different rankingBasis ⇒ different cache keys", async () => {
  const asOfDate = "2026-05-01";
  const k1 = buildCapabilityCacheKey(
    "sector_conviction_leaderboard",
    { rankingBasis: "conviction" },
    asOfDate,
  );
  const k2 = buildCapabilityCacheKey(
    "sector_conviction_leaderboard",
    { rankingBasis: "divergence" },
    asOfDate,
  );
  assert.notEqual(k1, k2);

  // Prior under k1 must not satisfy a request that would key under k2.
  const prior: CachedCapabilityView = {
    cacheKey: k1,
    capabilityName: "sector_conviction_leaderboard",
    viewSchemaVersion: 1,
    asOfDate,
    view: {
      viewSchemaVersion: 1,
      state: "complete",
      source: "pg_sector_peer_daily",
      period: "latest",
      rankingBasis: "conviction",
      asOfDate,
      rows: [],
      freshness: { dataThrough: asOfDate, state: "fresh" },
      warnings: [],
    } as any,
    generatedAt: "2026-05-01T18:00:00Z",
  };

  let runnerCalled = false;
  const result = await executePgCapabilitiesWithCache(
    {
      classification: leaderboardClassification,
      message: "Which sectors have conviction but weak price action?",
      snapshots: { freshness: { dataThrough: asOfDate } },
      toolOutputs: {},
    },
    [prior],
    async () => {
      runnerCalled = true;
      return {
        views: {
          sectorLeaderboardView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "pg_sector_peer_daily",
            period: "latest",
            rankingBasis: "divergence",
            asOfDate,
            rows: [],
            freshness: { dataThrough: asOfDate, state: "fresh" },
            warnings: [],
          },
        },
        warnings: [],
      };
    },
  );
  assert.equal(runnerCalled, true);
  assert.deepEqual(result.cacheStats, { hits: 0, misses: 1, writes: 1 });
});

test("executePgCapabilitiesWithCache skips cache when dataThrough is missing", async () => {
  let runnerCalled = false;
  const result = await executePgCapabilitiesWithCache(
    {
      classification: leaderboardClassification,
      message: "Which sectors are leading on conviction this week?",
      snapshots: {},
      toolOutputs: {},
    },
    [],
    async () => {
      runnerCalled = true;
      return {
        views: {
          sectorLeaderboardView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "pg_sector_peer_daily",
            period: "latest",
            rankingBasis: "conviction",
            rows: [],
            freshness: { state: "unknown" },
            warnings: [],
          },
        },
        warnings: [],
      };
    },
  );
  assert.equal(runnerCalled, true);
  assert.deepEqual(result.viewsUpdated, []);
  assert.deepEqual(result.cacheStats, { hits: 0, misses: 1, writes: 0 });
});

test("buildCapabilityCacheKey is deterministic and sorts keys", () => {
  const a = buildCapabilityCacheKey(
    "stock_vs_sector_comparison",
    { leftSymbol: "GSL", rightSector: "Industrials" },
    "2026-05-01",
  );
  const b = buildCapabilityCacheKey(
    "stock_vs_sector_comparison",
    { rightSector: "Industrials", leftSymbol: "GSL" },
    "2026-05-01",
  );
  assert.equal(a, b);
  assert.equal(
    a,
    "CAP:stock_vs_sector_comparison:2026-05-01:leftSymbol=GSL|rightSector=Industrials",
  );
});

test("buildCapabilityCacheKey omits params section when none are supplied", () => {
  assert.equal(
    buildCapabilityCacheKey("sector_momentum_vs_conviction_divergence", {}, "2026-05-01"),
    "CAP:sector_momentum_vs_conviction_divergence:2026-05-01",
  );
});

test("capabilityForClassification still routes stock_vs_sector for explicit-sector compare", () => {
  const entry = capabilityForClassification(comparisonClassification);
  assert.ok(entry);
  assert.equal(entry?.name, "stock_vs_sector_comparison");
});

test("capabilityForIntent('comparison') still resolves to the stock_vs_sector default", () => {
  const entry = capabilityForIntent("comparison");
  assert.ok(entry);
  assert.equal(entry?.name, "stock_vs_sector_comparison");
});

function assertNoForbiddenPublicKeys(value: unknown): void {
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /researchObjects/);
  assert.doesNotMatch(json, /parts/);
  assert.doesNotMatch(json, /publicSummary/);
  assert.doesNotMatch(json, /edge_id/);
  assert.doesNotMatch(json, /hypothesis_id/);
  assert.doesNotMatch(json, /raw_sql/);
  assert.doesNotMatch(json, /raw_rows/);
  assert.doesNotMatch(json, /analog_rows/);
  assert.doesNotMatch(json, /path_rows/);
  assert.doesNotMatch(json, /gate_name/);
  assert.doesNotMatch(json, /internal_threshold/);
  assert.doesNotMatch(json, /setup_score/);
  assert.doesNotMatch(json, /sector_delta_formula/);
  assert.doesNotMatch(json, /comparison_formula/);
  assert.doesNotMatch(json, /conviction_formula/);
  assert.doesNotMatch(json, /divergence_score_pct/);
  assert.doesNotMatch(json, /divergenceScorePct/);
  assert.doesNotMatch(json, /score_formula/);
  assert.doesNotMatch(json, /scoring_formula/);
  assert.doesNotMatch(json, /divergence_formula/);
  assert.doesNotMatch(json, /feature_rules/);
  assertNoFreshnessInternals(value);
}

function assertNoFreshnessInternals(value: unknown): void {
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /md_research_refresh_latest/);
  assert.doesNotMatch(json, /md_research_refresh_stale/);
  assert.doesNotMatch(json, /md_features_daily/);
  assert.doesNotMatch(json, /md_historical_features_daily/);
  assert.doesNotMatch(json, /md_research_sector_peer_daily/);
  assert.doesNotMatch(json, /md_research_sector_monday_hist/);
  assert.doesNotMatch(json, /md_research_sector_regime_fwd_agg/);
  assert.doesNotMatch(json, /pipeline_state/);
  assert.doesNotMatch(json, /run_id/);
  assert.doesNotMatch(json, /stage/);
  assert.doesNotMatch(json, /last_success_at/);
  assert.doesNotMatch(json, /completed_at/);
  assert.doesNotMatch(json, /max_age/);
  assert.doesNotMatch(json, /refresh logs/);
}
