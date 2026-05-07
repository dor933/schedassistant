import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkflowExecutionResult } from "../workflowExecution";
import {
  buildEvidencePackFromWorkflowExecution,
  evidencePackHasForbiddenInternals,
} from "../workflowEvidencePack";
import type { AnalystWorkflowName, WorkflowPublicViews } from "../analystTypes";

test("workflow EvidencePack builds from every approved WorkflowExecutionResult", () => {
  const workflows: AnalystWorkflowName[] = [
    "regime_to_stock_screen",
    "sector_delta_to_stock_screen",
    "sector_divergence_to_stock_screen",
    "feature_screen_plus_backtest",
    "stock_deep_dive_stack",
    "idea_to_compare_and_risk",
  ];

  for (const workflowName of workflows) {
    const result = buildWorkflowExecutionResult({
      workflowName,
      publicViews: viewsForWorkflow(workflowName),
      pipelineLabels: workflowName === "feature_screen_plus_backtest" ? {} : { GSL: "ראיה מאומתת קיימת" },
    });
    const pack = buildEvidencePackFromWorkflowExecution(result);
    assert.equal(pack.questionType, "compound_research");
    assert.equal(pack.workflowName, workflowName);
    assert.ok(pack.sourceViews.length > 0);
    assert.equal(evidencePackHasForbiddenInternals(pack), false);
  }
});

test("workflow EvidencePack carries candidate table, missing evidence, contradictions, and public confidence", () => {
  const result = buildWorkflowExecutionResult({
    workflowName: "regime_to_stock_screen",
    publicViews: {
      pgCapabilityViews: {
        featureScreenView: {
          viewSchemaVersion: 1,
          state: "complete",
          source: "pg_current_features",
          screenCriteria: [{ factor: "sector", bucket: "Technology" }],
          rows: [
            {
              symbol: "DLO",
              sector: "Technology",
              rank: 1,
              qualityBucket: "STRONG",
              hitRatePct: 43,
              medianReturnPct: -4.2,
              reasonBullets: ["Public sector screen result."],
            },
          ],
          freshness: { dataThrough: "2026-05-04", state: "fresh" },
          warnings: [],
        },
      },
    },
    pipelineLabels: {},
  });

  const pack = buildEvidencePackFromWorkflowExecution(result);
  assert.equal(pack.candidateTable?.[0].symbol, "DLO");
  assert.ok(pack.missingEvidence.some((item) => item.includes("Pipeline validation")));
  assert.ok(pack.contradictions.some((item) => item.includes("DLO")));
  assert.match(pack.confidence.explanation, /evidence/i);
  assert.equal(evidencePackHasForbiddenInternals(pack), false);
});

function viewsForWorkflow(workflowName: AnalystWorkflowName): WorkflowPublicViews {
  const featureScreenView = {
    viewSchemaVersion: 1,
    state: "complete" as const,
    source: "pg_current_features" as const,
    screenCriteria: [{ factor: "sector" as const, bucket: "Industrials" }],
    rows: [
      {
        symbol: "GSL",
        sector: "Industrials",
        rank: 1,
        qualityBucket: "STRONG",
        hitRatePct: 58.1,
        medianReturnPct: 3.2,
        reasonBullets: ["Public candidate row."],
      },
    ],
    freshness: { dataThrough: "2026-05-04", state: "fresh" as const },
    warnings: [],
  };
  const comparisonView = {
    viewSchemaVersion: 1,
    state: "complete" as const,
    comparisonType: "stock_vs_sector" as const,
    source: "pg_current_features" as const,
    left: { type: "stock" as const, label: "GSL", symbol: "GSL", metrics: {} },
    right: { type: "sector" as const, label: "Industrials", sector: "Industrials", metrics: {} },
    deltas: [
      {
        metric: "quality" as const,
        interpretationBucket: "left_stronger" as const,
        explanation: "Public comparison row.",
      },
    ],
    summaryBullets: ["GSL screens stronger on quality."],
    freshness: { dataThrough: "2026-05-04", state: "fresh" as const },
    warnings: [],
  };
  if (workflowName === "feature_screen_plus_backtest") {
    return {
      pgCapabilityViews: {
        featureScreenView,
        factorBacktestView: {
          viewSchemaVersion: 1,
          state: "complete",
          source: "pg_factor_history",
          horizon: "60-day",
          criteria: [{ factor: "quality", bucket: "STRONG" }],
          sampleSize: 120,
          hitRatePct: 55,
          medianReturnPct: 2,
          sampleAdequacy: "ROBUST",
          freshness: { dataThrough: "2026-02-02", state: "fresh" },
          warnings: [],
        },
      },
    };
  }
  if (workflowName === "stock_deep_dive_stack") {
    return { pgCapabilityViews: { comparisonView } };
  }
  if (workflowName === "idea_to_compare_and_risk") {
    return {
      pgCapabilityViews: {
        stockIdeaView: {
          viewSchemaVersion: 1,
          state: "complete",
          source: "pg_features_daily",
          rankingBasis: "setup_quality",
          rows: [
            {
              symbol: "GSL",
              sector: "Industrials",
              rank: 1,
              reasonBullets: ["Public idea row."],
            },
          ],
          freshness: { dataThrough: "2026-05-04", state: "fresh" },
          warnings: [],
        },
        comparisonView,
      },
    };
  }
  return { pgCapabilityViews: { featureScreenView } };
}
