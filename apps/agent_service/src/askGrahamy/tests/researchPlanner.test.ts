import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlannerPrompt,
  executeMockResearchPlan,
  parseResearchPlan,
  researchPlanSchema,
  shouldRunResearchPlanner,
  validateResearchPlan,
  type ResearchPlan,
} from "../researchPlanner";
import type { Classification } from "../types";

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
  const result = validateResearchPlan(plan);

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
