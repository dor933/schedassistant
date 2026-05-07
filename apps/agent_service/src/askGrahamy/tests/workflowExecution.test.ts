import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkflowExecutionResult,
  workflowResultHasForbiddenInternals,
} from "../workflowExecution";
import type { AnalystWorkflowName, WorkflowPublicViews } from "../analystTypes";

function featureScreenViews(): WorkflowPublicViews {
  return {
    pgCapabilityViews: {
      featureScreenView: {
        viewSchemaVersion: 1,
        state: "complete",
        source: "pg_current_features",
        asOfDate: "2026-05-04",
        screenCriteria: [{ factor: "sector", bucket: "Industrials" }],
        rows: [
          {
            symbol: "GSL",
            sector: "Industrials",
            rank: 1,
            qualityBucket: "STRONG",
            momentumBucket: "STRONG",
            hitRatePct: 58.1,
            medianReturnPct: 3.2,
            reasonBullets: ["Public sector-constrained screen result."],
          },
        ],
        freshness: { dataThrough: "2026-05-04", state: "fresh" },
        warnings: [],
      },
    },
  };
}

test("WorkflowExecutionResult normalizes every approved workflow shape", () => {
  const cases: Array<[AnalystWorkflowName, WorkflowPublicViews]> = [
    [
      "regime_to_stock_screen",
      {
        pgCapabilityViews: {
          ...featureScreenViews().pgCapabilityViews,
          regimeHistoricalPlaybookView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "pg_regime_history",
            regime: "NEUTRAL",
            rows: [
              { sector: "Industrials", rank: 1, role: "leader", interpretationBullets: [] },
            ],
            risks: [],
            summaryBullets: [],
            freshness: { dataThrough: "2026-05-04", state: "fresh" },
            warnings: [],
          },
        },
      },
    ],
    [
      "sector_delta_to_stock_screen",
      {
        pgCapabilityViews: {
          ...featureScreenViews().pgCapabilityViews,
          sectorDeltaView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "pg_sector_weekly_history",
            period: "week_over_week",
            rankingBasis: "conviction_delta",
            rows: [
              { sector: "Industrials", rank: 1, direction: "improved", interpretationBullets: [] },
            ],
            freshness: { dataThrough: "2026-05-04", state: "fresh" },
            warnings: [],
          },
        },
      },
    ],
    [
      "sector_divergence_to_stock_screen",
      {
        pgCapabilityViews: {
          ...featureScreenViews().pgCapabilityViews,
          sectorDivergenceView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "pg_sector_peer_daily",
            period: "latest",
            asOfDate: "2026-05-04",
            rows: [
              {
                sector: "Industrials",
                rank: 1,
                convictionBucket: "HIGH",
                momentumBucket: "WEAK",
                divergenceType: "conviction_but_weak_price_action",
                interpretationBullets: [],
              },
            ],
            freshness: { dataThrough: "2026-05-04", state: "fresh" },
            warnings: [],
          },
        },
      },
    ],
    [
      "feature_screen_plus_backtest",
      {
        pgCapabilityViews: {
          ...featureScreenViews().pgCapabilityViews,
          factorBacktestView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "pg_factor_history",
            horizon: "60-day",
            criteria: [{ factor: "quality", bucket: "STRONG" }],
            sampleSize: 125,
            hitRatePct: 55.2,
            medianReturnPct: 2.1,
            sampleAdequacy: "ROBUST",
            freshness: { dataThrough: "2026-02-02", state: "fresh" },
            warnings: [],
          },
        },
      },
    ],
    [
      "stock_deep_dive_stack",
      {
        pgCapabilityViews: { comparisonView: comparisonView() },
      },
    ],
    [
      "idea_to_compare_and_risk",
      {
        pgCapabilityViews: {
          stockIdeaView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "pg_features_daily",
            asOfDate: "2026-05-04",
            rankingBasis: "setup_quality",
            rows: [
              {
                symbol: "GSL",
                sector: "Industrials",
                rank: 1,
                hitRatePct: 58.1,
                medianReturnPct: 3.2,
                reasonBullets: ["Public stock idea candidate."],
              },
            ],
            freshness: { dataThrough: "2026-05-04", state: "fresh" },
            warnings: [],
          },
          comparisonView: comparisonView(),
        },
      },
    ],
  ];

  for (const [workflowName, publicViews] of cases) {
    const result = buildWorkflowExecutionResult({
      workflowName,
      publicViews,
      pipelineLabels: { GSL: "ראיה מאומתת קיימת" },
    });
    assert.equal(result.workflowName, workflowName);
    assert.ok(result.executedSteps.length > 0);
    assert.equal(workflowResultHasForbiddenInternals(result), false);
    assert.equal(JSON.stringify(result).includes("ResearchPlan"), false);
  }
});

test("WorkflowExecutionResult keeps PG candidates when optional Pipeline is unavailable", () => {
  const result = buildWorkflowExecutionResult({
    workflowName: "regime_to_stock_screen",
    publicViews: featureScreenViews(),
    pipelineLabels: {},
  });

  assert.equal(result.candidateRows?.[0].symbol, "GSL");
  assert.ok(
    result.missingEvidence.some((item) =>
      item.includes("Pipeline validation is unavailable"),
    ),
  );
});

test("WorkflowExecutionResult strips unsupported Pipeline labels to the public fallback label", () => {
  const result = buildWorkflowExecutionResult({
    workflowName: "regime_to_stock_screen",
    publicViews: featureScreenViews(),
    pipelineLabels: { GSL: "edge_id:secret" },
  });

  assert.equal(result.pipelineLabels?.GSL, "לא זמין בתור הזה");
  assert.equal(result.candidateRows?.[0].pipelineLabel, "לא זמין בתור הזה");
  assert.equal(workflowResultHasForbiddenInternals(result), false);
});

function comparisonView() {
  return {
    viewSchemaVersion: 1,
    state: "complete" as const,
    comparisonType: "stock_vs_sector" as const,
    source: "pg_current_features" as const,
    asOfDate: "2026-05-04",
    left: {
      type: "stock" as const,
      label: "GSL",
      symbol: "GSL",
      metrics: { convictionBucket: "HIGH" },
    },
    right: {
      type: "sector" as const,
      label: "Industrials",
      sector: "Industrials",
      metrics: { convictionBucket: "MIXED" },
    },
    deltas: [
      {
        metric: "conviction" as const,
        leftValue: "HIGH",
        rightValue: "MIXED",
        interpretationBucket: "left_stronger" as const,
        explanation: "Public comparison fields only.",
      },
    ],
    summaryBullets: ["GSL screens stronger than its sector on conviction."],
    freshness: { dataThrough: "2026-05-04", state: "fresh" as const },
    warnings: [],
  };
}
