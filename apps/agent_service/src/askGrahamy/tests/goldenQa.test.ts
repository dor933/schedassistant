import test from "node:test";
import assert from "node:assert/strict";
import { classifyMessage, type ClassifierOutput } from "../classification";
import { buildSystemPrompt } from "../grahamyAgent";
import { compilePublicResearchView } from "../publicResearch";
import type {
  AskGrahamyState,
  Classification,
  PgCapabilityViews,
  PublicResearchView,
} from "../types";
import {
  goldenCapabilityViews,
  goldenEmptyFeatureScreenView,
  goldenEmptySectorDivergenceView,
  goldenFactorBacktestView,
  goldenFeatureScreenView,
  goldenSectorDivergenceView,
  goldenSectorLeaderboardView,
  goldenStockIdeaView,
  goldenStockVsSectorComparisonView,
  goldenUnsupportedFactorBacktestView,
  goldenUnsupportedHorizonBacktestView,
  goldenUnavailableComparisonView,
} from "./fixtures/goldenCapabilityViews";
import {
  GOLDEN_QUESTIONS,
  RO_CLASSIFICATIONS,
} from "./fixtures/goldenQuestions";
import {
  goldenRegimeResearchObject,
  goldenSectorResearchObject,
  goldenStockResearchObject,
} from "./fixtures/goldenResearchObjects";

const baseSnapshots = {
  daily_brief: { regime: "NEUTRAL" },
  freshness: { dataThrough: "2026-05-01", generatedAt: "2026-05-01T14:00:00Z" },
};

const forbiddenKeys = [
  "researchObjects",
  "parts",
  "publicSummary",
  "edge_id",
  "hypothesis_id",
  "raw_sql",
  "raw_rows",
  "analog_rows",
  "path_rows",
  "gate_name",
  "internal_threshold",
  "pipeline_run_id",
  "feature_rules",
  "threshold_rule",
  "score_formula",
  "comparison_formula",
  "factor_formula",
  "internal_factor_definitions",
];

const forbiddenTerms = [
  "md_features_daily",
  "md_historical_features_daily",
  "md_forward_returns",
  "md_research_sector_peer_daily",
  "md_research_sector_monday_hist",
  "md_research_sector_regime_fwd_agg",
  "sweep_universe",
  "pipeline_state",
];

function classifierStub(out: ClassifierOutput) {
  return async (): Promise<ClassifierOutput> => out;
}

function classifierOutputFromClassification(
  classification: Classification,
): ClassifierOutput {
  return {
    intent: classification.intent,
    symbols: classification.symbols,
    sectors: classification.sectors,
    regimeRequested: classification.regimeRequested,
    isFollowUp: classification.isFollowUp,
    ...(classification.focus ? { focus: classification.focus } : {}),
    ...(classification.featureCriteria
      ? { featureCriteria: classification.featureCriteria }
      : {}),
    ...(classification.factorBacktest
      ? { factorBacktest: classification.factorBacktest }
      : {}),
    comparison: null,
    confidence: classification.confidence,
  } as ClassifierOutput;
}

function unknownStub(): Promise<ClassifierOutput> {
  return Promise.resolve({
    intent: "unknown",
    symbols: [],
    sectors: [],
    regimeRequested: false,
    isFollowUp: false,
    confidence: "medium",
    comparison: null,
  });
}

function classifierForGoldenQuestion(question: string): () => Promise<ClassifierOutput> {
  if (question === "Tell me about GSL") {
    return classifierStub(classifierOutputFromClassification(RO_CLASSIFICATIONS.stock));
  }
  if (question === "How is Energy?") {
    return classifierStub(classifierOutputFromClassification(RO_CLASSIFICATIONS.sector));
  }
  if (question === "What is the market regime now?") {
    return classifierStub(classifierOutputFromClassification(RO_CLASSIFICATIONS.regime));
  }
  if (question === "How risky is GSL?") {
    return classifierStub(classifierOutputFromClassification(RO_CLASSIFICATIONS.risk));
  }
  if (question === "Compare GSL to its sector") {
    return classifierStub({
      intent: "comparison",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      comparison: {
        comparisonType: "stock_vs_sector",
        left: { type: "stock", symbol: "GSL" },
        right: { type: "implicit_stock_sector", sector: null },
      },
      confidence: "high",
    });
  }
  if (question === "Compare Technology vs Industrials") {
    return classifierStub({
      intent: "comparison",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      comparison: {
        comparisonType: "sector_vs_sector",
        left: { type: "sector", sector: "Technology" },
        right: { type: "sector", sector: "Industrials" },
      },
      confidence: "high",
    });
  }
  if (question === "Compare GSL vs DAC") {
    return classifierStub({
      intent: "comparison",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      comparison: {
        comparisonType: "symbol_vs_symbol",
        left: { type: "stock", symbol: "GSL" },
        right: { type: "stock", symbol: "DAC" },
      },
      confidence: "high",
    });
  }
  if (question === "Find me cheap quality stocks") {
    return classifierStub({
      intent: "feature_screen",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      featureCriteria: goldenFeatureScreenView.screenCriteria,
      comparison: null,
      confidence: "high",
    });
  }
  if (question === "What happens historically when RSI is low and valuation is attractive?") {
    return classifierStub({
      intent: "factor_conditioned_backtest",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      factorBacktest: {
        horizon: "60-day",
        criteria: goldenFactorBacktestView.criteria,
      },
      comparison: null,
      confidence: "high",
    });
  }
  return classifierStub({
    intent: GOLDEN_QUESTIONS.find((item) => item.question === question)?.expectedIntent ?? "unknown",
    symbols: [],
    sectors: [],
    regimeRequested: false,
    isFollowUp: false,
    comparison: null,
    confidence: "high",
  } as ClassifierOutput);
}

function assertNoForbiddenPublicPayload(value: unknown): void {
  const json = JSON.stringify(value);
  for (const key of forbiddenKeys) {
    assert.equal(
      json.includes(`"${key}":`),
      false,
      `forbidden public key leaked: ${key}`,
    );
  }
  for (const term of forbiddenTerms) {
    assert.equal(
      json.toLowerCase().includes(term.toLowerCase()),
      false,
      `forbidden internal term leaked: ${term}`,
    );
  }
}

function compileGoldenView(input: {
  classification: Classification;
  pgCapabilityViews?: PgCapabilityViews;
  researchObjects?: Parameters<typeof compilePublicResearchView>[0]["researchObjects"];
}): PublicResearchView {
  return compilePublicResearchView({
    classification: input.classification,
    snapshots: baseSnapshots,
    toolOutputs: {
      get_market_context: { regime: "NEUTRAL" },
    },
    researchObjects: input.researchObjects ?? [],
    pgCapabilityViews: input.pgCapabilityViews,
    warnings: [],
  });
}

test("Golden QA classifier routes every supported non-pipeline question", async () => {
  for (const item of GOLDEN_QUESTIONS) {
    const result = await classifyMessage(item.question, undefined, {
      classifier: classifierForGoldenQuestion(item.question),
    });

    assert.equal(result.intent, item.expectedIntent, item.question);
    assert.equal(result.focus, item.expectedFocus, item.question);
    if (item.anchorless) {
      assert.deepEqual(result.symbols, [], item.question);
      assert.deepEqual(result.sectors, [], item.question);
    }
  }
});

test("Golden QA public view matrix exposes the expected safe view for every product question", () => {
  const cases: Array<{
    name: string;
    view: PublicResearchView;
    expectedView: keyof PublicResearchView;
    expectedState?: string;
    anchorless: boolean;
  }> = [
    {
      name: "Tell me about GSL",
      view: compileGoldenView({
        classification: RO_CLASSIFICATIONS.stock,
        researchObjects: [goldenStockResearchObject],
      }),
      expectedView: "researchObjectViews",
      anchorless: false,
    },
    {
      name: "How is Energy?",
      view: compileGoldenView({
        classification: RO_CLASSIFICATIONS.sector,
        researchObjects: [goldenSectorResearchObject],
      }),
      expectedView: "researchObjectViews",
      anchorless: false,
    },
    {
      name: "What is the market regime now?",
      view: compileGoldenView({
        classification: RO_CLASSIFICATIONS.regime,
        researchObjects: [goldenRegimeResearchObject],
      }),
      expectedView: "researchObjectViews",
      anchorless: false,
    },
    {
      name: "Which sectors are leading on conviction this week?",
      view: compileGoldenView({
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
        pgCapabilityViews: goldenCapabilityViews.sectorLeaderboard,
      }),
      expectedView: "sectorLeaderboardView",
      expectedState: "complete",
      anchorless: true,
    },
    {
      name: "Give me an interesting stock",
      view: compileGoldenView({
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
        pgCapabilityViews: goldenCapabilityViews.stockIdea,
      }),
      expectedView: "stockIdeaView",
      expectedState: "partial",
      anchorless: true,
    },
    {
      name: "Which sectors have conviction but weak price action?",
      view: compileGoldenView({
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
        pgCapabilityViews: goldenCapabilityViews.sectorDivergence,
      }),
      expectedView: "sectorDivergenceView",
      expectedState: "complete",
      anchorless: true,
    },
    {
      name: "Which sectors improved most versus last week?",
      view: compileGoldenView({
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
        pgCapabilityViews: goldenCapabilityViews.sectorDelta,
      }),
      expectedView: "sectorDeltaView",
      expectedState: "complete",
      anchorless: true,
    },
    {
      name: "Compare GSL to its sector",
      view: compileGoldenView({
        classification: {
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
        },
        pgCapabilityViews: goldenCapabilityViews.stockVsSectorComparison,
      }),
      expectedView: "comparisonView",
      expectedState: "partial",
      anchorless: true,
    },
    {
      name: "Compare Technology vs Industrials",
      view: compileGoldenView({
        classification: {
          intent: "comparison",
          symbols: [],
          sectors: [],
          regimeRequested: false,
          isFollowUp: false,
          comparison: {
            comparisonType: "sector_vs_sector",
            left: { type: "sector", sector: "Technology" },
            right: { type: "sector", sector: "Industrials" },
          },
          requiresTools: ["get_market_context"],
          confidence: "high",
          warnings: [],
        },
        pgCapabilityViews: goldenCapabilityViews.sectorVsSectorComparison,
      }),
      expectedView: "comparisonView",
      expectedState: "complete",
      anchorless: true,
    },
    {
      name: "Compare GSL vs DAC",
      view: compileGoldenView({
        classification: {
          intent: "comparison",
          symbols: [],
          sectors: [],
          regimeRequested: false,
          isFollowUp: false,
          comparison: {
            comparisonType: "symbol_vs_symbol",
            left: { type: "stock", symbol: "GSL" },
            right: { type: "stock", symbol: "DAC" },
          },
          requiresTools: ["get_market_context"],
          confidence: "high",
          warnings: [],
        },
        pgCapabilityViews: goldenCapabilityViews.symbolVsSymbolComparison,
      }),
      expectedView: "comparisonView",
      expectedState: "partial",
      anchorless: true,
    },
    {
      name: "How risky is GSL?",
      view: compileGoldenView({
        classification: RO_CLASSIFICATIONS.risk,
        researchObjects: [goldenStockResearchObject],
      }),
      expectedView: "researchObjectViews",
      anchorless: false,
    },
    {
      name: "What usually works in this regime?",
      view: compileGoldenView({
        classification: {
          intent: "market_regime_historical_playbook",
          symbols: [],
          sectors: [],
          regimeRequested: false,
          isFollowUp: false,
          requiresTools: ["get_market_context"],
          confidence: "high",
          warnings: [],
        },
        pgCapabilityViews: goldenCapabilityViews.regimePlaybook,
      }),
      expectedView: "regimeHistoricalPlaybookView",
      expectedState: "complete",
      anchorless: true,
    },
    {
      name: "Find me cheap quality stocks",
      view: compileGoldenView({
        classification: {
          intent: "feature_screen",
          symbols: [],
          sectors: [],
          regimeRequested: false,
          isFollowUp: false,
          featureCriteria: goldenFeatureScreenView.screenCriteria,
          requiresTools: ["get_market_context"],
          confidence: "high",
          warnings: [],
        },
        pgCapabilityViews: goldenCapabilityViews.featureScreen,
      }),
      expectedView: "featureScreenView",
      expectedState: "complete",
      anchorless: true,
    },
    {
      name: "What happens historically when RSI is low and valuation is attractive?",
      view: compileGoldenView({
        classification: {
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
        },
        pgCapabilityViews: goldenCapabilityViews.factorBacktest,
      }),
      expectedView: "factorBacktestView",
      expectedState: "complete",
      anchorless: true,
    },
  ];

  for (const item of cases) {
    assertNoForbiddenPublicPayload(item.view);
    if (item.anchorless) {
      assert.deepEqual(item.view.researchObjectKeys, [], item.name);
      assert.deepEqual(item.view.researchObjectViews, [], item.name);
    } else {
      assert.ok(item.view.researchObjectKeys.length > 0, item.name);
      assert.ok(item.view.researchObjectViews.length > 0, item.name);
    }

    const viewValue = item.view[item.expectedView];
    assert.ok(viewValue, item.name);
    if (item.expectedState && !Array.isArray(viewValue)) {
      assert.equal((viewValue as { state?: string }).state, item.expectedState, item.name);
    }
  }
});

test("Golden QA required public fields are present for representative views", () => {
  assert.equal(goldenSectorLeaderboardView.rows[0].sector, "Industrials");
  assert.ok(goldenStockIdeaView.rows[0].reasonBullets.length);
  assert.equal(
    goldenSectorDivergenceView.rows[0].divergenceType,
    "conviction_but_weak_price_action",
  );
  assert.equal(goldenSectorDivergenceView.rows.every((row) => row.divergenceType !== "in_line"), true);
  assert.ok(goldenSectorDivergenceView.freshness.dataThrough);
  assert.ok(goldenFeatureScreenView.asOfDate);
  assert.ok(goldenFactorBacktestView.sampleSize);
  assert.ok(goldenFactorBacktestView.freshness.dataThrough);
  assert.match(goldenFactorBacktestView.warnings.join(" "), /not today's or latest/i);
  assert.equal(
    goldenFactorBacktestView.warnings.join(" ").includes("current market data"),
    false,
  );
});

test("Golden QA negative cases stay unavailable, empty, or clarification-safe", async () => {
  const unsupportedFactor = await classifyMessage(
    "What happens historically when insider buying is high?",
    undefined,
    { classifier: unknownStub },
  );
  assert.equal(unsupportedFactor.intent, "factor_conditioned_backtest");
  assert.deepEqual(unsupportedFactor.factorBacktest?.unsupportedCriteria, [
    "insider buying",
  ]);
  assert.equal(goldenUnsupportedFactorBacktestView.state, "unavailable");
  assertNoForbiddenPublicPayload(goldenUnsupportedFactorBacktestView);

  const unsupportedHorizon = await classifyMessage(
    "What is the 15-day forward profile for cheap high-quality stocks?",
    undefined,
    { classifier: unknownStub },
  );
  assert.equal(unsupportedHorizon.intent, "factor_conditioned_backtest");
  assert.equal(unsupportedHorizon.factorBacktest?.unsupportedHorizon, "15-day");
  assert.equal(goldenUnsupportedHorizonBacktestView.state, "unavailable");

  const noAnchorRisk = await classifyMessage(
    "What is the probability of losing more than 10%?",
    undefined,
    {
      classifier: classifierStub({
        intent: "unknown",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: true,
        focus: "risk",
        confidence: "low",
        comparison: null,
      }),
    },
  );
  assert.equal(noAnchorRisk.intent, "unknown");
  assert.equal(noAnchorRisk.focus, undefined);

  const emptyDivergenceView = compileGoldenView({
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
    pgCapabilityViews: { sectorDivergenceView: goldenEmptySectorDivergenceView },
  });
  assert.equal(emptyDivergenceView.sectorDivergenceView?.state, "complete");
  assert.deepEqual(emptyDivergenceView.sectorDivergenceView?.rows, []);
  assert.match(emptyDivergenceView.sectorDivergenceView?.warnings.join(" ") ?? "", /No clear/i);

  const emptyFeatureView = compileGoldenView({
    classification: {
      intent: "feature_screen",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      featureCriteria: goldenFeatureScreenView.screenCriteria,
      requiresTools: ["get_market_context"],
      confidence: "high",
      warnings: [],
    },
    pgCapabilityViews: { featureScreenView: goldenEmptyFeatureScreenView },
  });
  assert.equal(emptyFeatureView.featureScreenView?.state, "complete");
  assert.deepEqual(emptyFeatureView.featureScreenView?.rows, []);

  const invalidComparisonView = compileGoldenView({
    classification: {
      intent: "comparison",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      comparison: {
        comparisonType: "stock_vs_sector",
        left: { type: "stock", symbol: "FAKE123" },
        right: { type: "sector", sector: "Banana Sector" },
      },
      requiresTools: ["get_market_context"],
      confidence: "medium",
      warnings: [],
    },
    pgCapabilityViews: { comparisonView: goldenUnavailableComparisonView },
  });
  assert.equal(invalidComparisonView.comparisonView?.state, "unavailable");
  assert.deepEqual(invalidComparisonView.comparisonView?.deltas, []);
  assertNoForbiddenPublicPayload(invalidComparisonView);
});

test("Golden QA prompt rules enforce public-only, no-current-factor, and no-trade-advice constraints", () => {
  const prompt = buildSystemPrompt({
    internalUserId: 1,
    conversationId: "golden",
    message: "What happens historically when RSI is low and valuation is attractive?",
    classification: {
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
    },
    snapshots: baseSnapshots,
    toolOutputs: { get_market_context: { regime: "NEUTRAL" } },
    pgCapabilityViews: { factorBacktestView: goldenFactorBacktestView },
    warnings: [],
  } satisfies AskGrahamyState);

  assert.match(prompt, /use only `factorBacktestView`/i);
  assert.match(prompt, /not a prediction, recommendation/i);
  assert.match(prompt, /Do not describe `factorBacktestView` as current/i);
  assert.match(prompt, /historical sample-through date/i);
  assert.match(prompt, /Do not expose thresholds, formulas, SQL, raw rows, table names/i);
  assertNoForbiddenPublicPayload(prompt);

  const riskPrompt = buildSystemPrompt({
    internalUserId: 1,
    conversationId: "golden-risk",
    message: "How risky is GSL?",
    classification: RO_CLASSIFICATIONS.risk,
    snapshots: baseSnapshots,
    toolOutputs: { get_market_context: { regime: "NEUTRAL" } },
    researchObjects: [goldenStockResearchObject],
    warnings: [],
  } satisfies AskGrahamyState);

  assert.match(riskPrompt, /If classification focus is `risk`, answer only/i);
  assert.match(riskPrompt, /Do not give stop-loss, position sizing, buy\/sell/i);
  assertNoForbiddenPublicPayload(
    compileGoldenView({
      classification: RO_CLASSIFICATIONS.risk,
      researchObjects: [goldenStockResearchObject],
    }),
  );
});
