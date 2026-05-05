import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAnalystBriefContract,
  buildEvidencePack,
  mapQuestionType,
} from "../analystOrchestration";
import type {
  Classification,
  PgCapabilityViews,
  ValidatedEdgeEvidenceView,
} from "../types";
import {
  goldenFactorBacktestView,
  goldenFeatureScreenView,
  goldenStockVsSectorComparisonView,
} from "./fixtures/goldenCapabilityViews";
import { goldenStockResearchObject } from "./fixtures/goldenResearchObjects";

const stockClassification: Classification = {
  intent: "stock",
  symbols: ["GSL"],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  requiresTools: ["get_stock_snapshot_context", "get_market_context"],
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

const factorClassification: Classification = {
  intent: "factor_conditioned_backtest",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  factorBacktest: {
    horizon: "60-day",
    criteria: goldenFactorBacktestView.criteria,
  },
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

const validatedClassification: Classification = {
  intent: "stock",
  symbols: ["GSL"],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  focus: "validated_evidence",
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

const validatedEdgeEvidenceView: ValidatedEdgeEvidenceView = {
  viewSchemaVersion: 1,
  state: "complete",
  source: "client_api_research_object",
  anchor: { type: "stock", symbol: "GSL", label: "GSL" },
  evidenceState: "edge_evidence_present",
  edgeCountBucket: "present",
  eventSampleBucket: "adequate",
  pipelineRiskBand: "moderate",
  liveConfirmationBucket: "mixed",
  decayRiskBucket: "watch",
  interpretationBullets: ["Pipeline validation is present for GSL."],
  freshness: { dataThrough: "2026-05-01", state: "fresh" },
  warnings: [],
};

test("EvidencePack maps intents and focus to analyst question types", () => {
  assert.equal(mapQuestionType(stockClassification), "stock_opinion");
  assert.equal(
    mapQuestionType({ ...stockClassification, focus: "risk" }),
    "risk",
  );
  assert.equal(mapQuestionType(comparisonClassification), "comparison");
  assert.equal(mapQuestionType(factorClassification), "factor_backtest");
  assert.equal(mapQuestionType(validatedClassification), "validated_pipeline_evidence");
});

test("EvidencePack builds from stock Research Object public view only", () => {
  const pack = buildEvidencePack({
    message: "Tell me about GSL",
    classification: stockClassification,
    researchObjects: [
      {
        ...goldenStockResearchObject,
        publicSummary: { raw_sql: "must-not-leak" },
        parts: { edge_id: "must-not-leak" },
      },
    ],
    warnings: [],
  });

  assert.equal(pack.questionType, "stock_opinion");
  assert.equal(pack.anchor?.symbol, "GSL");
  assert.equal(pack.currentSetup?.sourceView, "publicResearchObjectView");
  assert.equal(
    pack.historicalBaseRate?.sourceView,
    "publicResearchObjectView.probabilisticEvidence",
  );
  assert.equal(pack.pathRisk?.sourceView, "publicResearchObjectView.pathRisk");
  assert.equal(pack.confidence.level, "moderate");
  assertNoForbidden(pack);
});

test("EvidencePack builds from comparisonView", () => {
  const pack = buildEvidencePack({
    message: "Compare GSL to its sector",
    classification: comparisonClassification,
    pgCapabilityViews: {
      comparisonView: goldenStockVsSectorComparisonView,
    },
    warnings: [],
  });

  assert.equal(pack.questionType, "comparison");
  assert.equal(pack.anchor?.type, "comparison");
  assert.equal(pack.relativeComparison?.sourceView, "comparisonView");
  assert.match(pack.relativeComparison?.keyData.join(" ") ?? "", /conviction/i);
  assert.equal(pack.confidence.level, "moderate");
  assertNoForbidden(pack);
});

test("EvidencePack builds from factorBacktestView and detects weak historical contradiction", () => {
  const pack = buildEvidencePack({
    message: "What happens historically when RSI is low and valuation is attractive?",
    classification: factorClassification,
    pgCapabilityViews: {
      factorBacktestView: goldenFactorBacktestView,
    },
    warnings: [],
  });

  assert.equal(pack.questionType, "factor_backtest");
  assert.equal(pack.timeHorizon, "60-day");
  assert.equal(pack.historicalBaseRate?.sourceView, "factorBacktestView");
  assert.equal(pack.confidence.level, "moderate");
  assert.match(pack.contradictions.join(" "), /historical evidence is weak/i);
  assertNoForbidden(pack);
});

test("EvidencePack builds from validatedEdgeEvidenceView and flags live/decay contradictions", () => {
  const pack = buildEvidencePack({
    message: "Is GSL evidence-backed?",
    classification: validatedClassification,
    pipelineOverlayViews: { validatedEdgeEvidenceView },
    warnings: [],
  });

  assert.equal(pack.questionType, "validated_pipeline_evidence");
  assert.equal(pack.pipelineEvidence?.sourceView, "validatedEdgeEvidenceView");
  assert.deepEqual(pack.sourceViews, ["validatedEdgeEvidenceView"]);
  assert.match(pack.contradictions.join(" "), /live confirmation is not clean/i);
  assert.match(pack.contradictions.join(" "), /decay\/caution bucket/i);
  assert.equal(pack.confidence.level, "low");
  assertNoForbidden(pack);
});

test("EvidencePack detects missing evidence and synthesizes low confidence", () => {
  const staleFeatureScreen = {
    ...goldenFeatureScreenView,
    state: "partial" as const,
    rows: [
      {
        symbol: "ABC",
        rank: 1,
        qualityBucket: "STRONG",
        momentumBucket: "WEAK",
        reasonBullets: ["Strong quality but weak momentum."],
      },
    ],
    freshness: {
      dataThrough: "2026-04-20",
      state: "stale" as const,
      warning: "This view is stale.",
    },
  };
  const pgCapabilityViews: PgCapabilityViews = {
    featureScreenView: staleFeatureScreen,
  };
  const pack = buildEvidencePack({
    message: "Which stocks have strong quality but weak momentum?",
    classification: {
      intent: "feature_screen",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      featureCriteria: staleFeatureScreen.screenCriteria,
      requiresTools: ["get_market_context"],
      confidence: "high",
      warnings: [],
    },
    pgCapabilityViews,
    warnings: [],
  });

  assert.equal(pack.questionType, "feature_screen");
  assert.match(pack.contradictions.join(" "), /strong quality evidence but weak momentum/i);
  assert.match(pack.missingEvidence.join(" "), /stale/i);
  assert.equal(pack.confidence.level, "low");
  assertNoForbidden(pack);
});

test("AnalystBrief contract carries required sections, tables, caveats, confidence, and follow-ups", () => {
  const pack = buildEvidencePack({
    message: "Tell me about GSL",
    classification: stockClassification,
    researchObjects: [goldenStockResearchObject],
    warnings: [],
  });
  const brief = buildAnalystBriefContract(pack);

  assert.equal(brief.sections[0].id, "why_it_matters");
  assert.ok(brief.sections.some((section) => section.id === "supports"));
  assert.ok(brief.sections.some((section) => section.id === "concerns"));
  assert.ok(brief.sections.some((section) => section.id === "risk"));
  assert.ok(brief.sections.some((section) => section.id === "what_changes_view"));
  assert.ok(brief.sections.some((section) => section.id === "data_limitations"));
  assert.ok(brief.sections.some((section) => section.id === "confidence"));
  assert.ok(brief.tables.some((table) => table.type === "evidence"));
  assert.ok(brief.tables.some((table) => table.type === "risk"));
  assert.equal(brief.confidence.level, pack.confidence.level);
  assert.ok(brief.sources.some((source) => source.label === "Research Object"));
  assert.ok(brief.followUps.length > 0);
  assertNoForbidden(brief);
});

function assertNoForbidden(value: unknown): void {
  const json = JSON.stringify(value);
  for (const forbidden of [
    "researchObjects",
    "parts",
    "publicSummary",
    "raw_sql",
    "raw_rows",
    "edge_id",
    "hypothesis_id",
    "pipeline_run_id",
    "feature_rules",
    "threshold_rule",
    "score_formula",
    "comparison_formula",
    "factor_formula",
    "internal_factor_definitions",
    "md_features_daily",
    "md_historical_features_daily",
    "md_forward_returns",
    "sweep_universe",
    "pipeline_state",
  ]) {
    assert.equal(
      json.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `forbidden value leaked: ${forbidden}`,
    );
  }
}
