import test from "node:test";
import assert from "node:assert/strict";
import { compilePublicResearchView } from "../publicResearch";
import { buildResearchObjects } from "../researchObjectBuilder";
import {
  PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION,
  type CachedResearchObject,
  type Classification,
} from "../types";

const classification: Classification = {
  intent: "stock",
  symbols: ["NVDA"],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  requiresTools: [],
  confidence: "high",
  warnings: [],
};

const cachedResearchObject: CachedResearchObject = {
  cacheKey: "STOCK:NVDA:2026-04-30",
  objectType: "stock",
  anchor: "NVDA",
  asOfDate: "2026-04-30",
  generatedAt: "2026-04-30T00:00:00.000Z",
  source: "database",
  publicSummary: {
    symbol: "NVDA",
    company: "NVIDIA Corp.",
    whyNow: "NVDA backdrop is constructive.",
    historicalEvidence: "ROBUST",
    invalidationSignals: ["Earnings miss would reset the setup."],
    edge_id: "must-not-leak",
    raw_sql: "select * from internal_table",
    activeSignals: [
      {
        family: "Trajectory",
        signalStrength: "STRONG",
        evidenceLanguage: "Revenue accelerating and margins expanding.",
      },
    ],
  },
  parts: {
    core: {
      analog_rows: [{ analog_date: "2020-01-01" }],
      gate_name: "internal_gate",
      analog_evidence_self: {
        self_history: {
          n: 34,
          n_with_h60: 30,
          sample_adequacy: "ADEQUATE",
          h60_hit_rate: 61,
          h60_median_pct: 6,
          h60_p25_pct: -4,
          h60_p75_pct: 12,
          path_risk_base: {
            source: "pg_daily_price_path_self_analogs",
            horizon: "60-day",
            n: 30,
            loss_rate_h60_pct: 39,
            severe_loss_rate_h60_pct: 11,
            p25_adverse_excursion_pct: -8,
            p25_max_drawdown_pct: -10,
            p10_max_drawdown_pct: -14,
            worst_max_drawdown_pct: -31,
            prob_drawdown_gt_5_pct: 32,
            prob_drawdown_gt_10_pct: 18,
            prob_drawdown_gt_15_pct: 8,
            prob_drawdown_gt_20_pct: 3,
            recovered_by_horizon_rate_pct: 72,
            median_recovery_days: 24,
            sample_adequacy: "ADEQUATE",
          },
        },
      },
    },
    sectorAggregates: {
      analog_evidence_sector: {
        n: 1820,
        n_with_h60: 1800,
        sample_adequacy: "ROBUST",
        h60_hit_rate: 56,
        h60_median_pct: 4,
        h60_p25_pct: -6,
        h60_p75_pct: 11,
        bucket_key: {
          sector: "Technology",
          regime: "RISK_ON",
          pe_bin: 4,
          rsi_bin: 3,
        },
      },
    },
    financialQuality: {},
    path_rows: [{ path_day: 1, drawdown: -0.1 }],
  },
  freshness: { dataThrough: "2026-04-30" },
  warnings: [],
};

test("publicResearchView projects numeric base-rate and daily path-risk fields", () => {
  const view = compilePublicResearchView({
    classification,
    snapshots: { freshness: { dataThrough: "2026-04-30" } },
    toolOutputs: {},
    researchObjects: [cachedResearchObject],
    warnings: [],
  });

  assert.equal(view.researchObjectViews.length, 1);
  assert.equal((view as Record<string, unknown>).researchObjects, undefined);

  const probability = view.probabilisticEvidence[cachedResearchObject.cacheKey];
  assert.equal(probability.viewSchemaVersion, PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION);
  assert.equal(probability.referenceSet, "self_analogs");
  assert.equal(probability.sampleSize, 30);
  assert.equal(probability.hitRatePct, 61);
  assert.equal(probability.medianReturnPct, 6);
  assert.equal(probability.p25ReturnPct, -4);
  assert.equal(probability.p75ReturnPct, 12);
  assert.equal(probability.hitRateBucket, "STRONG");

  const pathRisk = view.pathRisk[cachedResearchObject.cacheKey];
  assert.equal(pathRisk.viewSchemaVersion, PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION);
  assert.equal(pathRisk.state, "complete");
  assert.equal(pathRisk.source, "pg_daily_price_path");
  assert.equal(pathRisk.sampleSize, 30);
  assert.equal(pathRisk.p10MaxDrawdownPct, -14);
  assert.equal(pathRisk.worstMaxDrawdownPct, -31);
  assert.equal(pathRisk.probDrawdownGt5Pct, 32);
  assert.equal(pathRisk.probDrawdownGt10Pct, 18);
  assert.equal(pathRisk.probDrawdownGt15Pct, 8);
  assert.equal(pathRisk.probDrawdownGt20Pct, 3);
  assert.equal(pathRisk.recoveredByHorizonRatePct, 72);
  assert.equal(pathRisk.maxDrawdownBucket, "ELEVATED_DOWNSIDE");
});

test("publicResearchView falls back to partial return distribution when daily path is absent", () => {
  const withoutPath = cloneResearchObject(cachedResearchObject);
  const selfHistory = (((withoutPath.parts.core as Record<string, unknown>)
    .analog_evidence_self as Record<string, unknown>)
    .self_history as Record<string, unknown>);
  delete selfHistory.path_risk_base;

  const view = compilePublicResearchView({
    classification,
    snapshots: { freshness: { dataThrough: "2026-04-30" } },
    toolOutputs: {},
    researchObjects: [withoutPath],
    warnings: [],
  });

  const pathRisk = view.pathRisk[withoutPath.cacheKey];
  assert.equal(pathRisk.state, "partial");
  assert.equal(pathRisk.source, "analog_return_distribution");
  assert.equal(pathRisk.p10MaxDrawdownPct, undefined);
  assert.equal(pathRisk.worstMaxDrawdownPct, undefined);
  assert.equal(pathRisk.probDrawdownGt10Pct, undefined);
  assert.match(pathRisk.warnings?.join(" ") ?? "", /Numeric drawdown distribution is unavailable/);
});

test("publicResearchView does not leak raw objects, internal ids, raw SQL, raw analog rows, gates, or thresholds", () => {
  const view = compilePublicResearchView({
    classification,
    snapshots: { freshness: { dataThrough: "2026-04-30" } },
    toolOutputs: {},
    researchObjects: [cachedResearchObject],
    warnings: [],
  });

  assertNoForbiddenPublicKeys(view);
});

test("publicResearchView includes PG sector leaderboard view without raw research objects", () => {
  const view = compilePublicResearchView({
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
          },
        ],
        freshness: { dataThrough: "2026-05-01", state: "fresh" },
        warnings: [],
      },
    },
    warnings: [],
  });

  assert.equal(view.researchObjectViews.length, 0);
  assert.equal(view.researchObjectKeys.length, 0);
  assert.equal(view.sectorLeaderboardView?.state, "complete");
  assert.equal(view.sectorLeaderboardView?.rows[0]?.sector, "Industrials");
  assertNoForbiddenPublicKeys(view);
});

test("publicResearchView includes stock idea discovery view without raw research objects", () => {
  const view = compilePublicResearchView({
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
            momentumBucket: "STRONG",
            reasonBullets: ["Sector-relative conviction bucket is HIGH."],
          },
        ],
        freshness: { dataThrough: "2026-05-01", state: "fresh" },
        warnings: ["These are research candidates to review."],
      },
    },
    warnings: [],
  });

  assert.equal(view.researchObjectViews.length, 0);
  assert.equal(view.researchObjectKeys.length, 0);
  assert.equal(view.stockIdeaView?.state, "partial");
  assert.equal(view.stockIdeaView?.rows[0]?.symbol, "GSL");
  assert.equal(view.evidence.stockIdeaRows, 1);
  assertNoForbiddenPublicKeys(view);
});

test("publicResearchView includes sector divergence view without raw research objects", () => {
  const view = compilePublicResearchView({
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
    warnings: [],
  });

  assert.equal(view.objectType, "sector");
  assert.equal(view.researchObjectViews.length, 0);
  assert.equal(view.researchObjectKeys.length, 0);
  assert.equal(view.sectorDivergenceView?.state, "complete");
  assert.equal(view.sectorDivergenceView?.rows[0]?.sector, "Utilities");
  assert.equal(view.evidence.sectorDivergenceRows, 1);
  assertNoForbiddenPublicKeys(view);
});

test("publicResearchView includes sector delta view without raw research objects", () => {
  const view = compilePublicResearchView({
    classification: {
      intent: "week_over_week_sector_delta",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      requiresTools: ["get_market_context"],
      confidence: "high",
      warnings: [],
    },
    snapshots: { freshness: { dataThrough: "2026-04-27" } },
    toolOutputs: {},
    researchObjects: [],
    pgCapabilityViews: {
      sectorDeltaView: {
        viewSchemaVersion: 1,
        state: "complete",
        source: "pg_sector_weekly_history",
        period: "week_over_week",
        currentAsOfDate: "2026-04-27",
        priorAsOfDate: "2026-04-20",
        rankingBasis: "overall_change",
        rows: [
          {
            sector: "Technology",
            rank: 1,
            currentConvictionScorePct: 76,
            priorConvictionScorePct: 68,
            convictionDeltaPct: 8,
            currentConvictionBucket: "HIGH",
            priorConvictionBucket: "CONSTRUCTIVE",
            currentMomentumBucket: "STRONG",
            priorMomentumBucket: "MIXED",
            momentumDeltaPct: 5,
            direction: "improved",
            interpretationBullets: [
              "Weekly conviction proxy improved by 8 points.",
            ],
          },
        ],
        freshness: { dataThrough: "2026-04-27", state: "fresh" },
        warnings: [],
      },
    },
    warnings: [],
  });

  assert.equal(view.objectType, "sector");
  assert.equal(view.researchObjectViews.length, 0);
  assert.equal(view.researchObjectKeys.length, 0);
  assert.equal(view.sectorDeltaView?.state, "complete");
  assert.equal(view.sectorDeltaView?.rows[0]?.sector, "Technology");
  assert.equal(view.evidence.sectorDeltaRows, 1);
  assertNoForbiddenPublicKeys(view);
});

test("stale cached views are rebuilt from parts and marked for persistence", async () => {
  const previousHost = process.env.EXTERNAL_PG_HOST;
  const previousDb = process.env.EXTERNAL_PG_DATABASE;
  process.env.EXTERNAL_PG_HOST = "configured-for-prior-hit-test";
  process.env.EXTERNAL_PG_DATABASE = "configured-for-prior-hit-test";

  try {
    const stale = cloneResearchObject(cachedResearchObject);
    stale.view = {
      viewSchemaVersion: 1,
      cacheKey: stale.cacheKey,
      objectType: "stock",
      anchor: "NVDA",
      asOfDate: "2026-04-30",
      fiveQuestion: {
        whatMattersNow: [],
        historicalAnalogs: [],
        underWhichConditions: [],
        invalidation: [],
      },
      edgeEvidence: {
        state: "unavailable",
        source: "unavailable",
        claims: [],
        warnings: [],
      },
      probabilisticEvidence: {
        viewSchemaVersion: 1,
        state: "unavailable",
        horizon: "60-day",
        notes: [],
      },
      pathRisk: {
        viewSchemaVersion: 1,
        state: "unavailable",
        horizon: "60-day",
        notes: [],
      },
      freshness: {},
      warnings: [],
    };

    const result = await buildResearchObjects({
      classification,
      snapshots: { freshness: { dataThrough: "2026-04-30" } },
      toolOutputs: {},
      priorResearchObjects: [stale],
    });

    assert.equal(result.stats.hits, 1);
    assert.equal(result.stats.writes, 1);
    assert.equal(result.objectsUpdated.length, 1);
    assert.equal(
      result.objects[0]?.view?.viewSchemaVersion,
      PUBLIC_RESEARCH_VIEW_SCHEMA_VERSION,
    );
    assert.equal(
      result.objects[0]?.view?.probabilisticEvidence.hitRatePct,
      61,
    );
  } finally {
    if (previousHost == null) delete process.env.EXTERNAL_PG_HOST;
    else process.env.EXTERNAL_PG_HOST = previousHost;
    if (previousDb == null) delete process.env.EXTERNAL_PG_DATABASE;
    else process.env.EXTERNAL_PG_DATABASE = previousDb;
  }
});

function cloneResearchObject(value: CachedResearchObject): CachedResearchObject {
  return JSON.parse(JSON.stringify(value)) as CachedResearchObject;
}

function assertNoForbiddenPublicKeys(value: unknown): void {
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /researchObjects/);
  assert.doesNotMatch(json, /edge_id/);
  assert.doesNotMatch(json, /hypothesis_id/);
  assert.doesNotMatch(json, /raw_sql/);
  assert.doesNotMatch(json, /raw_rows/);
  assert.doesNotMatch(json, /signal_sql/);
  assert.doesNotMatch(json, /analog_rows/);
  assert.doesNotMatch(json, /path_rows/);
  assert.doesNotMatch(json, /gate_name/);
  assert.doesNotMatch(json, /internal_threshold/);
  assert.doesNotMatch(json, /setup_score/);
  assert.doesNotMatch(json, /sector_delta_formula/);
  assert.doesNotMatch(json, /conviction_formula/);
  assert.doesNotMatch(json, /divergence_score_pct/);
  assert.doesNotMatch(json, /divergenceScorePct/);
  assert.doesNotMatch(json, /score_formula/);
  assert.doesNotMatch(json, /feature_rules/);
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
}
