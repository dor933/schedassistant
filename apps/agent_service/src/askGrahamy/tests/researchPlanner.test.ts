import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlannerPrompt,
  executeMockResearchPlan,
  executeResearchPlan,
  parseResearchPlan,
  researchPlanSchema,
  shouldRunResearchPlanner,
  validateResearchWorkflow,
  validateResearchPlan,
  type ResearchPlan,
} from "../researchPlanner";
import type { Classification, FeatureScreenCriterion } from "../types";

const compoundHebrewQuestion =
  "איזה סקטור נוטה להיות חזק במצב השוק הנוכחי ואיזה מניות היסטורית חזקות אני רוצה שתמצא לי משהו נוכחי שעונה על הצלחות חוזרות היסטוריות";

const validCompoundPlan: ResearchPlan = {
  planType: "multi_step",
  steps: [
    {
      id: "regime_context",
      capability: "market_regime_historical_playbook",
      purpose: "Identify sectors that historically lead in the current regime.",
      params: {},
    },
    {
      id: "current_candidates",
      capability: "feature_screen",
      purpose: "Find current stocks inside the historically leading sectors.",
      params: {},
      dependsOn: ["regime_context"],
      paramsFromPreviousSteps: {
        sectorConstraints: {
          stepId: "regime_context",
          sourcePath: "regimeHistoricalPlaybookView.rows[role=leader].sector",
          transform: "top_3_unique_sectors",
        },
      },
    },
    {
      id: "pipeline_check",
      capability: "validated_edge_evidence",
      purpose: "Qualify top current candidates with public Pipeline evidence if available.",
      params: { topN: 3 },
      dependsOn: ["current_candidates"],
      paramsFromPreviousSteps: {
        symbols: {
          stepId: "current_candidates",
          sourcePath: "featureScreenView.rows.symbol",
          transform: "top_3_symbols",
        },
      },
      optional: true,
    },
  ],
  finalAnswerGoal: "ranked_research_candidates",
  expectedViews: [
    "regimeHistoricalPlaybookView",
    "featureScreenView",
    "validatedEdgeEvidenceView",
  ],
  safetyNotes: [
    "Use public views only",
    "Do not invent stocks",
    "Pipeline evidence is optional",
  ],
};

const sectorDeltaPlan: ResearchPlan = {
  planType: "multi_step",
  steps: [
    {
      id: "delta_context",
      capability: "week_over_week_sector_delta",
      purpose: "Identify sectors that improved this week.",
      params: {},
    },
    {
      id: "current_candidates",
      capability: "feature_screen",
      purpose: "Find current stocks inside improved sectors.",
      params: {},
      dependsOn: ["delta_context"],
      paramsFromPreviousSteps: {
        sectorConstraints: {
          stepId: "delta_context",
          sourcePath: "sectorDeltaView.rows[direction=improved].sector",
          transform: "top_3_improved_sectors",
        },
      },
    },
    {
      id: "pipeline_check",
      capability: "validated_edge_evidence",
      purpose: "Qualify top current candidates if public Pipeline evidence is available.",
      params: { topN: 3 },
      dependsOn: ["current_candidates"],
      paramsFromPreviousSteps: {
        symbols: {
          stepId: "current_candidates",
          sourcePath: "featureScreenView.rows.symbol",
          transform: "top_3_symbols",
        },
      },
      optional: true,
    },
  ],
  finalAnswerGoal: "ranked_research_candidates",
  expectedViews: ["sectorDeltaView", "featureScreenView", "validatedEdgeEvidenceView"],
  safetyNotes: ["Use public views only"],
};

const divergencePlan: ResearchPlan = {
  ...sectorDeltaPlan,
  steps: [
    {
      id: "divergence_context",
      capability: "sector_momentum_vs_conviction_divergence",
      purpose: "Identify sectors with public conviction-versus-price divergence.",
      params: {},
    },
    {
      id: "current_candidates",
      capability: "feature_screen",
      purpose: "Find current stocks inside divergence sectors.",
      params: {},
      dependsOn: ["divergence_context"],
      paramsFromPreviousSteps: {
        sectorConstraints: {
          stepId: "divergence_context",
          sourcePath: "sectorDivergenceView.rows.sector",
          transform: "top_3_divergence_sectors",
        },
      },
    },
    sectorDeltaPlan.steps[2],
  ],
  expectedViews: ["sectorDivergenceView", "featureScreenView", "validatedEdgeEvidenceView"],
};

const screenPlusBacktestPlan: ResearchPlan = {
  planType: "multi_step",
  steps: [
    {
      id: "screen",
      capability: "feature_screen",
      purpose: "Find current cheap quality stocks.",
      params: {
        criteria: [
          { factor: "valuation", bucket: "ATTRACTIVE" },
          { factor: "quality", bucket: "STRONG" },
        ],
      },
    },
    {
      id: "backtest",
      capability: "factor_conditioned_backtest",
      purpose: "Check the aggregate historical outcome profile for the same public criteria.",
      params: { horizon: "60-day" },
      dependsOn: ["screen"],
      paramsFromPreviousSteps: {
        criteria: {
          stepId: "screen",
          sourcePath: "featureScreenView.screenCriteria",
          transform: "public_criteria_only",
        },
      },
    },
  ],
  finalAnswerGoal: "screen_candidates_with_aggregate_history",
  expectedViews: ["featureScreenView", "factorBacktestView"],
  safetyNotes: ["Aggregate backtest only"],
};

const stockDeepDivePlan: ResearchPlan = {
  planType: "multi_step",
  steps: [
    {
      id: "stock",
      capability: "stock_research_object",
      purpose: "Build the public stock Research Object.",
      params: { symbol: "AMZN" },
    },
    {
      id: "risk",
      capability: "risk_path",
      purpose: "Use the public stock path-risk fields.",
      params: { symbol: "AMZN" },
      dependsOn: ["stock"],
    },
    {
      id: "comparison",
      capability: "comparison",
      purpose: "Compare the stock to its sector using public comparison evidence.",
      params: { comparisonType: "stock_vs_sector", symbol: "AMZN" },
      dependsOn: ["stock"],
    },
    {
      id: "pipeline",
      capability: "validated_edge_evidence",
      purpose: "Qualify the stock with public Pipeline evidence if available.",
      params: { topN: 1, symbol: "AMZN" },
      dependsOn: ["stock"],
      optional: true,
    },
  ],
  finalAnswerGoal: "stock_deep_dive_with_risk_and_sector_comparison",
  expectedViews: ["researchObjectViews", "comparisonView", "validatedEdgeEvidenceView"],
  safetyNotes: ["Use public views only"],
};

const ideaCompareRiskPlan: ResearchPlan = {
  planType: "multi_step",
  steps: [
    {
      id: "idea",
      capability: "stock_idea_discovery",
      purpose: "Find one public research candidate.",
      params: {},
    },
    {
      id: "comparison",
      capability: "comparison",
      purpose: "Compare the top candidate to its sector.",
      params: { comparisonType: "stock_vs_sector" },
      dependsOn: ["idea"],
      paramsFromPreviousSteps: {
        symbol: {
          stepId: "idea",
          sourcePath: "stockIdeaView.rows[0].symbol",
          transform: "top_candidate_symbol",
        },
      },
    },
    {
      id: "risk",
      capability: "risk_path",
      purpose: "Use the top candidate public risk fields.",
      params: {},
      dependsOn: ["idea"],
      paramsFromPreviousSteps: {
        symbol: {
          stepId: "idea",
          sourcePath: "stockIdeaView.rows[0].symbol",
          transform: "top_candidate_symbol",
        },
      },
    },
    {
      id: "pipeline",
      capability: "validated_edge_evidence",
      purpose: "Qualify the top candidate with public Pipeline evidence if available.",
      params: { topN: 1 },
      dependsOn: ["idea"],
      paramsFromPreviousSteps: {
        symbol: {
          stepId: "idea",
          sourcePath: "stockIdeaView.rows[0].symbol",
          transform: "top_candidate_symbol",
        },
      },
      optional: true,
    },
  ],
  finalAnswerGoal: "research_candidate_with_sector_comparison_and_risk",
  expectedViews: ["stockIdeaView", "researchObjectViews", "comparisonView", "validatedEdgeEvidenceView"],
  safetyNotes: ["Call it a research candidate"],
};

const neutralClassification: Classification = {
  intent: "market_regime_historical_playbook",
  symbols: [],
  sectors: [],
  regimeRequested: false,
  isFollowUp: false,
  requiresTools: ["get_market_context"],
  confidence: "high",
  warnings: [],
};

function classificationWith(
  patch: Partial<Classification>,
): Classification {
  return {
    intent: "unknown",
    symbols: [],
    sectors: [],
    regimeRequested: false,
    isFollowUp: false,
    requiresTools: [],
    confidence: "high",
    warnings: [],
    ...patch,
  };
}

test("activation gate only selects clear compound regime-to-stock research questions", () => {
  assert.equal(
    shouldRunResearchPlanner(compoundHebrewQuestion, neutralClassification),
    true,
  );

  assert.equal(
    shouldRunResearchPlanner(
      "Tell me about GSL",
      classificationWith({ intent: "stock", symbols: ["GSL"] }),
    ),
    false,
  );
  assert.equal(
    shouldRunResearchPlanner(
      "Compare GSL vs DAC",
      classificationWith({ intent: "comparison" }),
    ),
    false,
  );
  assert.equal(
    shouldRunResearchPlanner(
      "How risky is GSL?",
      classificationWith({ intent: "stock", symbols: ["GSL"], focus: "risk" }),
    ),
    false,
  );
  assert.equal(
    shouldRunResearchPlanner(
      "Is GSL evidence-backed?",
      classificationWith({
        intent: "stock",
        symbols: ["GSL"],
        focus: "validated_evidence",
      }),
    ),
    false,
  );
  assert.equal(
    shouldRunResearchPlanner(
      "Find me cheap quality stocks",
      classificationWith({
        intent: "feature_screen",
        featureCriteria: [
          { factor: "valuation", bucket: "ATTRACTIVE" },
          { factor: "quality", bucket: "STRONG" },
        ],
      }),
    ),
    false,
  );
  assert.equal(
    shouldRunResearchPlanner(
      "What happens historically when RSI is low and valuation is attractive?",
      classificationWith({ intent: "factor_conditioned_backtest" }),
    ),
    false,
  );
});

test("activation gate selects approved compound workflow questions", () => {
  assert.equal(
    shouldRunResearchPlanner(
      "Which sectors improved this week and which stocks are interesting there?",
      classificationWith({ intent: "week_over_week_sector_delta" }),
    ),
    true,
  );
  assert.equal(
    shouldRunResearchPlanner(
      "איפה יש פער בין ראיות למחיר ואיזה מניות מעניינות שם?",
      classificationWith({ intent: "sector_momentum_vs_conviction_divergence" }),
    ),
    true,
  );
  assert.equal(
    shouldRunResearchPlanner(
      "Find cheap quality stocks and show whether this setup worked historically.",
      classificationWith({ intent: "feature_screen" }),
    ),
    true,
  );
  assert.equal(
    shouldRunResearchPlanner(
      "תן לי ניתוח מלא על AMZN כולל סיכון והשוואה לסקטור",
      classificationWith({ intent: "stock", symbols: ["AMZN"] }),
    ),
    true,
  );
  assert.equal(
    shouldRunResearchPlanner(
      "Give me an interesting stock and compare it to its sector with risk.",
      classificationWith({ intent: "stock_idea_discovery" }),
    ),
    true,
  );
});

test("planner prompt teaches Sonnet to produce a bounded multi-step plan for the Hebrew compound question", () => {
  const prompt = buildPlannerPrompt(compoundHebrewQuestion);
  const serialized = prompt.map((message) => message.content).join("\n");

  assert.match(serialized, /market_regime_historical_playbook/);
  assert.match(serialized, /feature_screen/);
  assert.match(serialized, /validated_edge_evidence/);
  assert.match(serialized, /regimeHistoricalPlaybookView\.rows\[role=leader\]\.sector/);
  assert.match(serialized, /structured ResearchPlan/i);
  assert.match(serialized, /feature_screen must have explicit public criteria or sectorConstraints/i);
  assert.match(serialized, /validated_edge_evidence is optional/i);
  assert.doesNotMatch(serialized, /grahamy_discovery\.db/i);
});

test("Hebrew compound question fixture parses as expected valid multi-step plan", () => {
  const plan = parseResearchPlan(validCompoundPlan);
  const result = validateResearchWorkflow(plan);

  assert.equal(plan.planType, "multi_step");
  assert.deepEqual(
    plan.steps.map((step) => step.capability),
    [
      "market_regime_historical_playbook",
      "feature_screen",
      "validated_edge_evidence",
    ],
  );
  assert.equal(plan.finalAnswerGoal, "ranked_research_candidates");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.workflow?.workflowName, "regime_to_stock_screen");
});

test("workflow validator accepts every approved V2 workflow pattern", () => {
  const plans = [
    [validCompoundPlan, "regime_to_stock_screen"],
    [sectorDeltaPlan, "sector_delta_to_stock_screen"],
    [divergencePlan, "sector_divergence_to_stock_screen"],
    [screenPlusBacktestPlan, "feature_screen_plus_backtest"],
    [stockDeepDivePlan, "stock_deep_dive_stack"],
    [ideaCompareRiskPlan, "idea_to_compare_and_risk"],
  ] as const;

  for (const [plan, workflowName] of plans) {
    const result = validateResearchWorkflow(plan);
    assert.equal(result.ok, true, workflowName);
    assert.equal(result.ok && result.workflow?.workflowName, workflowName);
  }
});

test("workflow validator rejects wrong step order even when capabilities are allowlisted", () => {
  const result = validateResearchWorkflow({
    ...sectorDeltaPlan,
    steps: [sectorDeltaPlan.steps[1], sectorDeltaPlan.steps[0]],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /approved bounded research workflow/i);
});

test("validator rejects unknown capabilities", () => {
  const raw = {
    ...validCompoundPlan,
    steps: [
      {
        ...validCompoundPlan.steps[0],
        capability: "raw_pipeline_sql",
      },
    ],
  };

  assert.throws(() => researchPlanSchema.parse(raw));
});

test("validator rejects unbounded feature_screen", () => {
  const plan: ResearchPlan = {
    ...validCompoundPlan,
    steps: [
      validCompoundPlan.steps[0],
      {
        id: "bad_screen",
        capability: "feature_screen",
        purpose: "Run a broad current stock screen.",
        params: {},
      },
    ],
  };

  const result = validateResearchPlan(plan);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /feature_screen must have bounded criteria/i);
});

test("validator rejects raw SQL, table, and internal requests", () => {
  const plan: ResearchPlan = {
    ...validCompoundPlan,
    steps: [
      {
        id: "unsafe",
        capability: "feature_screen",
        purpose: "Use raw SQL and expose table rows.",
        params: {
          criteria: [{ factor: "quality", bucket: "STRONG" }],
          raw_sql: "select * from md_hypotheses",
          edge_id: "abc",
        },
      },
    ],
  };

  const result = validateResearchPlan(plan);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /forbidden internal data/i);
});

test("validator requires validated_edge_evidence to be optional for candidate output", () => {
  const plan: ResearchPlan = {
    ...validCompoundPlan,
    steps: validCompoundPlan.steps.map((step) =>
      step.capability === "validated_edge_evidence"
        ? { ...step, optional: false }
        : step,
    ),
  };

  const result = validateResearchPlan(plan);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /must be optional/i);
});

test("mock executor passes leader sectors from regime step into feature_screen", () => {
  const result = executeMockResearchPlan({
    plan: validCompoundPlan,
    fixtureOutputs: {
      regime_context: {
        regimeHistoricalPlaybookView: {
          rows: [
            { sector: "Industrials", role: "leader", rank: 1 },
            { sector: "Technology", role: "leader", rank: 2 },
            { sector: "Utilities", role: "laggard", rank: 3 },
          ],
        },
      },
      current_candidates: {
        featureScreenView: {
          rows: [
            {
              symbol: "GSL",
              sector: "Industrials",
              hitRatePct: 58.1,
              medianReturnPct: 3.2,
            },
            {
              symbol: "AMZN",
              sector: "Technology",
              hitRatePct: 52.2,
              medianReturnPct: 1.4,
            },
          ],
        },
      },
      pipeline_check: {
        validatedEdgeEvidenceView: {
          state: "unavailable",
          warnings: ["Pipeline evidence unavailable for the candidates."],
        },
      },
    },
  });

  const featureStep = result.steps.find((step) => step.capability === "feature_screen");
  assert.deepEqual(featureStep?.params.sectorConstraints, [
    "Industrials",
    "Technology",
  ]);
  assert.equal(
    JSON.stringify(featureStep?.params).includes("Utilities"),
    false,
  );
});

test("mock executor passes top feature_screen symbols into optional validated_edge_evidence", () => {
  const result = executeMockResearchPlan({
    plan: validCompoundPlan,
    fixtureOutputs: {
      regime_context: {
        regimeHistoricalPlaybookView: {
          rows: [{ sector: "Industrials", role: "leader", rank: 1 }],
        },
      },
      current_candidates: {
        featureScreenView: {
          rows: [
            { symbol: "GSL", sector: "Industrials" },
            { symbol: "MLI", sector: "Industrials" },
            { symbol: "ISSC", sector: "Industrials" },
            { symbol: "FOURTH", sector: "Industrials" },
          ],
        },
      },
      pipeline_check: {},
    },
  });

  const pipelineStep = result.steps.find(
    (step) => step.capability === "validated_edge_evidence",
  );
  assert.deepEqual(pipelineStep?.params.symbols, ["GSL", "MLI", "ISSC"]);
});

test("mock execution result has no raw/internal fields and no recommendation language", () => {
  const result = executeMockResearchPlan({
    plan: validCompoundPlan,
    fixtureOutputs: {
      regime_context: {
        regimeHistoricalPlaybookView: {
          rows: [{ sector: "Industrials", role: "leader", rank: 1 }],
        },
      },
      current_candidates: {
        featureScreenView: {
          rows: [{ symbol: "GSL", sector: "Industrials", hitRatePct: 58.1 }],
        },
      },
      pipeline_check: {},
    },
  });

  assertNoForbidden(result);
  assert.equal(
    JSON.stringify(result).toLowerCase().includes("buy"),
    false,
  );
  assert.equal(
    JSON.stringify(result).toLowerCase().includes("sell"),
    false,
  );
});

test("real executor runs supported compound plan, merges sector screens, dedupes rows, and labels Pipeline evidence", async () => {
  const pgCalls: Array<{ intent: string; sector?: string }> = [];
  const pipelineSymbols: string[] = [];
  const result = await executeResearchPlan({
    plan: validCompoundPlan,
    message: compoundHebrewQuestion,
    classification: neutralClassification,
    snapshots: { freshness: { dataThrough: "2026-05-04" } },
    toolOutputs: {},
    pgCapabilityRunner: async (input) => {
      if (input.classification.intent === "market_regime_historical_playbook") {
        pgCalls.push({ intent: input.classification.intent });
        return {
          views: {
            regimeHistoricalPlaybookView: {
              viewSchemaVersion: 1,
              state: "complete",
              source: "pg_regime_history",
              regime: "NEUTRAL",
              asOfDate: "2026-05-04",
              rows: [
                { sector: "Technology", rank: 2, role: "leader", interpretationBullets: [] },
                { sector: "Industrials", rank: 1, role: "leader", interpretationBullets: [] },
                { sector: "Utilities", rank: 3, role: "laggard", interpretationBullets: [] },
              ],
              risks: [],
              summaryBullets: [],
              freshness: { dataThrough: "2026-05-04", state: "fresh" },
              warnings: [],
            },
          },
          warnings: [],
        };
      }
      if (input.classification.intent === "feature_screen") {
        const sector = input.classification.featureCriteria?.[0]?.bucket;
        pgCalls.push({ intent: input.classification.intent, sector });
        const rows =
          sector === "Industrials"
            ? [
                {
                  symbol: "GSL",
                  sector: "Industrials",
                  rank: 1,
                  hitRatePct: 58.1,
                  medianReturnPct: 3.2,
                  reasonBullets: ["Sector filter matched Industrials."],
                },
                {
                  symbol: "MLI",
                  sector: "Industrials",
                  rank: 2,
                  hitRatePct: 54,
                  medianReturnPct: 2.1,
                  reasonBullets: ["Sector filter matched Industrials."],
                },
              ]
            : [
                {
                  symbol: "AMZN",
                  sector: "Technology",
                  rank: 1,
                  hitRatePct: 52.2,
                  medianReturnPct: 1.4,
                  reasonBullets: ["Sector filter matched Technology."],
                },
                {
                  symbol: "GSL",
                  sector: "Industrials",
                  rank: 9,
                  hitRatePct: 40,
                  medianReturnPct: -1,
                  reasonBullets: ["Duplicate weaker row."],
                },
              ];
        return {
          views: {
            featureScreenView: {
              viewSchemaVersion: 1,
              state: "complete",
              source: "pg_current_features",
              asOfDate: "2026-05-04",
              screenCriteria: input.classification.featureCriteria ?? [],
              rows,
              freshness: { dataThrough: "2026-05-04", state: "fresh" },
              warnings: [],
            },
          },
          warnings: [],
        };
      }
      return { views: {}, warnings: [] };
    },
    pipelineOverlayRunner: async (input) => {
      const symbol = input.classification.symbols[0];
      pipelineSymbols.push(symbol);
      return {
        views: {
          validatedEdgeEvidenceView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "client_api_research_object",
            anchor: { type: "stock", symbol, label: symbol },
            evidenceState:
              symbol === "GSL" ? "edge_evidence_present" : "insufficient_data",
            interpretationBullets: [],
            freshness: { dataThrough: "2026-05-04", state: "fresh" },
            warnings: [],
          },
        },
        warnings: [],
      };
    },
  });

  assert.equal(result.handled, true);
  assert.deepEqual(pgCalls, [
    { intent: "market_regime_historical_playbook" },
    { intent: "feature_screen", sector: "Industrials" },
    { intent: "feature_screen", sector: "Technology" },
  ]);
  assert.deepEqual(
    result.pgCapabilityViews?.featureScreenView?.screenCriteria.map((item) => item.bucket),
    ["Industrials", "Technology"],
  );
  assert.deepEqual(
    result.pgCapabilityViews?.featureScreenView?.rows.map((row) => row.symbol),
    ["GSL", "AMZN", "MLI"],
  );
  assert.deepEqual(pipelineSymbols, ["GSL", "AMZN", "MLI"]);
  assert.equal(
    result.compoundResearchContext?.candidatePipelineLabels?.GSL,
    "ראיה מאומתת קיימת",
  );
  assert.equal(
    result.compoundResearchContext?.candidatePipelineLabels?.AMZN,
    "אין מספיק ראיה",
  );
  assertNoForbidden(result);
});

test("real executor keeps PG candidates when optional Pipeline validation fails", async () => {
  const result = await executeResearchPlan({
    plan: validCompoundPlan,
    message: compoundHebrewQuestion,
    classification: neutralClassification,
    snapshots: { freshness: { dataThrough: "2026-05-04" } },
    toolOutputs: {},
    pgCapabilityRunner: async (input) => {
      if (input.classification.intent === "market_regime_historical_playbook") {
        return {
          views: {
            regimeHistoricalPlaybookView: {
              viewSchemaVersion: 1,
              state: "complete",
              source: "pg_regime_history",
              regime: "NEUTRAL",
              asOfDate: "2026-05-04",
              rows: [{ sector: "Industrials", rank: 1, role: "leader", interpretationBullets: [] }],
              risks: [],
              summaryBullets: [],
              freshness: { dataThrough: "2026-05-04", state: "fresh" },
              warnings: [],
            },
          },
          warnings: [],
        };
      }
      return {
        views: {
          featureScreenView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "pg_current_features",
            asOfDate: "2026-05-04",
            screenCriteria: input.classification.featureCriteria ?? [],
            rows: [
              {
                symbol: "GSL",
                sector: "Industrials",
                rank: 1,
                reasonBullets: ["Sector filter matched Industrials."],
              },
            ],
            freshness: { dataThrough: "2026-05-04", state: "fresh" },
            warnings: [],
          },
        },
        warnings: [],
      };
    },
    pipelineOverlayRunner: async () => {
      throw new Error("timeout");
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.pgCapabilityViews?.featureScreenView?.rows[0].symbol, "GSL");
  assert.equal(
    result.compoundResearchContext?.candidatePipelineLabels?.GSL,
    "לא זמין בתור הזה",
  );
});

test("real executor returns sector context without hallucinated stocks when screens have no rows", async () => {
  const result = await executeResearchPlan({
    plan: validCompoundPlan,
    message: compoundHebrewQuestion,
    classification: neutralClassification,
    snapshots: { freshness: { dataThrough: "2026-05-04" } },
    toolOutputs: {},
    pgCapabilityRunner: async (input) => {
      if (input.classification.intent === "market_regime_historical_playbook") {
        return {
          views: {
            regimeHistoricalPlaybookView: {
              viewSchemaVersion: 1,
              state: "complete",
              source: "pg_regime_history",
              regime: "NEUTRAL",
              asOfDate: "2026-05-04",
              rows: [{ sector: "Industrials", rank: 1, role: "leader", interpretationBullets: [] }],
              risks: [],
              summaryBullets: [],
              freshness: { dataThrough: "2026-05-04", state: "fresh" },
              warnings: [],
            },
          },
          warnings: [],
        };
      }
      return {
        views: {
          featureScreenView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "pg_current_features",
            asOfDate: "2026-05-04",
            screenCriteria: input.classification.featureCriteria ?? [],
            rows: [],
            freshness: { dataThrough: "2026-05-04", state: "fresh" },
            warnings: ["No stocks matched the supplied public screen criteria."],
          },
        },
        warnings: [],
      };
    },
    pipelineOverlayRunner: async () => {
      throw new Error("Pipeline should not run without symbols.");
    },
  });

  assert.equal(result.handled, true);
  assert.deepEqual(result.pgCapabilityViews?.featureScreenView?.rows, []);
  assert.equal(
    result.pgCapabilityViews?.featureScreenView?.warnings.some((warning) =>
      warning.includes("No current stock candidates matched"),
    ),
    true,
  );
  assert.deepEqual(result.compoundResearchContext?.candidatePipelineLabels, {});
  assertNoForbidden(result);
});

test("real executor runs sector_delta_to_stock_screen using improved sectors only", async () => {
  const sectorsSeen: string[] = [];
  const result = await executeResearchPlan({
    plan: sectorDeltaPlan,
    message: "Which sectors improved this week and which stocks are interesting there?",
    classification: classificationWith({ intent: "week_over_week_sector_delta" }),
    snapshots: {},
    toolOutputs: {},
    pgCapabilityRunner: async (input) => {
      if (input.classification.intent === "week_over_week_sector_delta") {
        return {
          views: {
            sectorDeltaView: {
              viewSchemaVersion: 1,
              state: "complete",
              source: "pg_sector_weekly_history",
              period: "week_over_week",
              rankingBasis: "overall_change",
              rows: [
                { sector: "Technology", rank: 1, direction: "improved", interpretationBullets: [] },
                { sector: "Utilities", rank: 2, direction: "deteriorated", interpretationBullets: [] },
              ],
              freshness: { dataThrough: "2026-05-04", state: "fresh" },
              warnings: [],
            },
          },
          warnings: [],
        };
      }
      sectorsSeen.push(input.classification.featureCriteria?.[0]?.bucket ?? "");
      return featureScreenResult(input.classification.featureCriteria?.[0]?.bucket ?? "Unknown");
    },
    pipelineOverlayRunner: async () => {
      throw new Error("optional Pipeline unavailable");
    },
  });

  assert.equal(result.handled, true);
  assert.deepEqual(sectorsSeen, ["Technology"]);
  assert.deepEqual(
    result.pgCapabilityViews?.featureScreenView?.rows.map((row) => row.sector),
    ["Technology"],
  );
  assert.equal(JSON.stringify(result).includes("Utilities"), true);
  assert.equal(
    result.pgCapabilityViews?.featureScreenView?.screenCriteria.some(
      (criterion) => criterion.bucket === "Utilities",
    ),
    false,
  );
  assertNoForbidden(result);
});

test("real executor runs sector_divergence_to_stock_screen and returns no candidates when no true divergence rows exist", async () => {
  const result = await executeResearchPlan({
    plan: divergencePlan,
    message: "איפה יש פער בין ראיות למחיר ואיזה מניות מעניינות שם?",
    classification: classificationWith({ intent: "sector_momentum_vs_conviction_divergence" }),
    snapshots: {},
    toolOutputs: {},
    pgCapabilityRunner: async () => ({
      views: {
        sectorDivergenceView: {
          viewSchemaVersion: 1,
          state: "complete",
          source: "pg_sector_peer_daily",
          period: "latest",
          rows: [],
          freshness: { dataThrough: "2026-05-04", state: "fresh" },
          warnings: [],
        },
      },
      warnings: [],
    }),
  });

  assert.equal(result.handled, true);
  assert.deepEqual(result.pgCapabilityViews?.featureScreenView?.rows, []);
  assertNoForbidden(result);
});

test("real executor runs feature_screen_plus_backtest and passes public screen criteria to aggregate backtest", async () => {
  const seen: Array<{ intent: string; criteria: unknown }> = [];
  const result = await executeResearchPlan({
    plan: screenPlusBacktestPlan,
    message: "Find cheap quality stocks and show whether this setup worked historically.",
    classification: classificationWith({ intent: "feature_screen" }),
    snapshots: {},
    toolOutputs: {},
    pgCapabilityRunner: async (input) => {
      seen.push({
        intent: input.classification.intent,
        criteria:
          input.classification.intent === "factor_conditioned_backtest"
            ? input.classification.factorBacktest?.criteria
            : input.classification.featureCriteria,
      });
      if (input.classification.intent === "feature_screen") {
        return featureScreenResult(
          "Industrials",
          input.classification.featureCriteria ?? [],
        );
      }
      return {
        views: {
          factorBacktestView: {
            viewSchemaVersion: 1,
            state: "complete",
            source: "pg_factor_history",
            horizon: "60-day",
            criteria: input.classification.factorBacktest?.criteria ?? [],
            sampleSize: 125,
            hitRatePct: 57,
            medianReturnPct: 2.5,
            freshness: { dataThrough: "2026-02-02", state: "fresh" },
            warnings: ["Aggregate historical evidence only."],
          },
        },
        warnings: [],
      };
    },
  });

  assert.equal(result.handled, true);
  assert.deepEqual(seen, [
    {
      intent: "feature_screen",
      criteria: [
        { factor: "valuation", bucket: "ATTRACTIVE" },
        { factor: "quality", bucket: "STRONG" },
      ],
    },
    {
      intent: "factor_conditioned_backtest",
      criteria: [
        { factor: "valuation", bucket: "ATTRACTIVE" },
        { factor: "quality", bucket: "STRONG" },
      ],
    },
  ]);
  assert.equal(result.pgCapabilityViews?.factorBacktestView?.sampleSize, 125);
  assert.match(result.compoundResearchContext?.warnings.join(" ") ?? "", /aggregate historical context/i);
  assertNoForbidden(result);
});

test("real executor runs stock_deep_dive_stack without introducing extra symbols", async () => {
  const comparisonSymbols: string[] = [];
  const pipelineSymbols: string[] = [];
  const result = await executeResearchPlan({
    plan: stockDeepDivePlan,
    message: "What do you think about AMZN? Include risk and sector comparison.",
    classification: classificationWith({ intent: "stock", symbols: ["AMZN"] }),
    snapshots: { freshness: { dataThrough: "2026-05-04" } },
    toolOutputs: {},
    researchObjectBuilder: async (input) => ({
      objects: [mockCachedResearchObject(input.classification.symbols[0])],
      objectsUpdated: [],
      stats: { hits: 1, misses: 0, writes: 0 },
      warnings: [],
    }),
    pgCapabilityRunner: async (input) => {
      const symbol = comparisonLeftSymbol(input.classification.comparison) ?? "";
      comparisonSymbols.push(symbol);
      return comparisonResult(symbol || "AMZN");
    },
    pipelineOverlayRunner: async (input) => {
      pipelineSymbols.push(input.classification.symbols[0]);
      return pipelineResult(input.classification.symbols[0]);
    },
  });

  assert.equal(result.handled, true);
  assert.deepEqual(result.researchObjects?.map((object) => object.anchor), ["AMZN"]);
  assert.deepEqual(result.researchObjectsUpdated, []);
  assert.deepEqual(comparisonSymbols, ["AMZN"]);
  assert.deepEqual(pipelineSymbols, ["AMZN"]);
  assert.equal(result.compoundResearchContext?.selectedSymbol, "AMZN");
  assertNoForbidden(result);
});

test("real executor runs idea_to_compare_and_risk from top stock idea only", async () => {
  const symbols: string[] = [];
  const result = await executeResearchPlan({
    plan: ideaCompareRiskPlan,
    message: "Give me an interesting stock and compare it to its sector with risk.",
    classification: classificationWith({ intent: "stock_idea_discovery" }),
    snapshots: {},
    toolOutputs: {},
    researchObjectBuilder: async (input) => {
      symbols.push(input.classification.symbols[0]);
      return {
        objects: [mockCachedResearchObject(input.classification.symbols[0])],
        objectsUpdated: [],
        stats: { hits: 1, misses: 0, writes: 0 },
        warnings: [],
      };
    },
    pgCapabilityRunner: async (input) => {
      if (input.classification.intent === "stock_idea_discovery") {
        return {
          views: {
            stockIdeaView: {
              viewSchemaVersion: 1,
              state: "complete",
              source: "pg_features_daily",
              asOfDate: "2026-05-04",
              rankingBasis: "setup_quality",
              rows: [
                { symbol: "GSL", sector: "Industrials", rank: 1, reasonBullets: [] },
                { symbol: "DAC", sector: "Industrials", rank: 2, reasonBullets: [] },
              ],
              freshness: { dataThrough: "2026-05-04", state: "fresh" },
              warnings: [],
            },
          },
          warnings: [],
        };
      }
      return comparisonResult(comparisonLeftSymbol(input.classification.comparison) ?? "");
    },
    pipelineOverlayRunner: async (input) => pipelineResult(input.classification.symbols[0]),
  });

  assert.equal(result.handled, true);
  assert.deepEqual(symbols, ["GSL"]);
  assert.deepEqual(result.researchObjectsUpdated, []);
  assert.equal(result.pgCapabilityViews?.comparisonView?.left.symbol, "GSL");
  assert.equal(result.compoundResearchContext?.selectedSymbol, "GSL");
  assert.match(result.compoundResearchContext?.warnings.join(" ") ?? "", /research candidate/i);
  assertNoForbidden(result);
});

test("real executor declines unsupported plan shapes for standard fallback", async () => {
  const result = await executeResearchPlan({
    plan: {
      ...validCompoundPlan,
      steps: [
        {
          id: "ideas",
          capability: "stock_idea_discovery",
          purpose: "Find broad stock ideas.",
          params: {},
        },
      ],
    },
    message: compoundHebrewQuestion,
    classification: neutralClassification,
    snapshots: {},
    toolOutputs: {},
  });

  assert.equal(result.handled, false);
});

function featureScreenResult(
  sector: string,
  criteria: FeatureScreenCriterion[] = [{ factor: "sector", bucket: sector }],
) {
  return {
    views: {
      featureScreenView: {
        viewSchemaVersion: 1,
        state: "complete" as const,
        source: "pg_current_features" as const,
        asOfDate: "2026-05-04",
        screenCriteria: criteria,
        rows: [
          {
            symbol: sector === "Technology" ? "AMZN" : "GSL",
            sector,
            rank: 1,
            hitRatePct: 58,
            medianReturnPct: 3.1,
            reasonBullets: [`Sector filter matched ${sector}.`],
          },
        ],
        freshness: { dataThrough: "2026-05-04", state: "fresh" as const },
        warnings: [],
      },
    },
    warnings: [],
  };
}

function comparisonResult(symbol: string) {
  return {
    views: {
      comparisonView: {
        viewSchemaVersion: 1,
        state: "complete" as const,
        comparisonType: "stock_vs_sector" as const,
        source: "pg_current_features" as const,
        asOfDate: "2026-05-04",
        left: {
          type: "stock" as const,
          label: symbol,
          symbol,
          sector: "Industrials",
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
            interpretationBucket: "left_stronger" as const,
            explanation: "Compares public conviction fields.",
          },
        ],
        summaryBullets: [`${symbol} screens stronger than its sector on conviction.`],
        freshness: { dataThrough: "2026-05-04", state: "fresh" as const },
        warnings: [],
      },
    },
    warnings: [],
  };
}

function pipelineResult(symbol: string) {
  return {
    views: {
      validatedEdgeEvidenceView: {
        viewSchemaVersion: 1,
        state: "complete" as const,
        source: "client_api_research_object" as const,
        anchor: { type: "stock" as const, symbol, label: symbol },
        evidenceState: "edge_evidence_present" as const,
        interpretationBullets: [],
        freshness: { dataThrough: "2026-05-04", state: "fresh" as const },
        warnings: [],
      },
    },
    warnings: [],
  };
}

function comparisonLeftSymbol(
  comparison: Classification["comparison"] | undefined,
): string | undefined {
  return comparison?.left.type === "stock" ? comparison.left.symbol : undefined;
}

function mockCachedResearchObject(symbol: string) {
  return {
    cacheKey: `STOCK:${symbol}:2026-05-04`,
    objectType: "stock" as const,
    anchor: symbol,
    asOfDate: "2026-05-04",
    generatedAt: "2026-05-04T00:00:00.000Z",
    source: "database" as const,
    publicSummary: {},
    parts: {},
    view: {
      viewSchemaVersion: 1,
      cacheKey: `STOCK:${symbol}:2026-05-04`,
      objectType: "stock" as const,
      anchor: symbol,
      asOfDate: "2026-05-04",
      fiveQuestion: {
        whatMattersNow: [],
        historicalAnalogs: [],
        underWhichConditions: [],
        invalidation: [],
      },
      edgeEvidence: {
        state: "unavailable" as const,
        source: "unavailable" as const,
        claims: [],
        warnings: [],
      },
      probabilisticEvidence: {
        viewSchemaVersion: 1,
        state: "unavailable" as const,
        horizon: "60-day" as const,
        notes: [],
      },
      pathRisk: {
        viewSchemaVersion: 1,
        state: "unavailable" as const,
        horizon: "60-day" as const,
        source: "unavailable" as const,
        warnings: [],
        notes: [],
      },
      freshness: { dataThrough: "2026-05-04" },
      warnings: [],
    },
    freshness: { dataThrough: "2026-05-04" },
    warnings: [],
  };
}

function assertNoForbidden(value: unknown): void {
  const json = JSON.stringify(value).toLowerCase();
  for (const forbidden of [
    "raw_sql",
    "raw_rows",
    "edge_id",
    "hypothesis_id",
    "feature_rules",
    "threshold",
    "gates",
    "sqlite",
    "grahamy_discovery",
    "pipeline_state",
    "md_hypotheses",
  ]) {
    assert.equal(json.includes(forbidden), false, `forbidden leak: ${forbidden}`);
  }
}
