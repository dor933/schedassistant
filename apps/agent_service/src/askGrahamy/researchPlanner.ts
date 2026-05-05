import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { z } from "zod";
import { logger } from "../logger";
import { anthropicBaseConfig } from "../chat/anthropic/anthropicContextManagement";
import { resolveOrgVendorByOrg } from "../utils/resolveOrgVendor.service";
import type {
  Classification,
  FeatureScreenCriterion,
  FeatureScreenRowView,
  FeatureScreenView,
  CompoundResearchContext,
  PgCapabilityViews,
  PipelineOverlayViews,
  SnapshotBundle,
  ToolOutputs,
  ValidatedEdgeEvidenceView,
} from "./types";
import {
  executePgCapabilitiesWithCache,
} from "./pgCapabilities/registry";
import { executePipelineOverlays } from "./pipelineOverlays/registry";
import type {
  PgCapabilityRunInput,
  PgCapabilityRunResult,
} from "./pgCapabilities/types";
import type {
  PipelineOverlayRunInput,
  PipelineOverlayRunResult,
} from "./pipelineOverlays/registry";

export const PLANNABLE_CAPABILITIES = [
  "stock_research_object",
  "sector_research_object",
  "regime_research_object",
  "market_regime_historical_playbook",
  "sector_conviction_leaderboard",
  "sector_momentum_vs_conviction_divergence",
  "week_over_week_sector_delta",
  "stock_idea_discovery",
  "feature_screen",
  "factor_conditioned_backtest",
  "comparison",
  "risk_path",
  "validated_edge_evidence",
] as const;

export type PlannedCapability = (typeof PLANNABLE_CAPABILITIES)[number];

export type ResearchPlanStep = {
  id: string;
  capability: PlannedCapability;
  purpose: string;
  params: Record<string, unknown>;
  dependsOn?: string[];
  paramsFromPreviousSteps?: Record<
    string,
    {
      stepId: string;
      sourcePath: string;
      transform: string;
    }
  >;
  optional?: boolean;
};

export type ResearchPlan = {
  planType: "single_step" | "multi_step";
  steps: ResearchPlanStep[];
  finalAnswerGoal: string;
  expectedViews: string[];
  safetyNotes: string[];
};

export type PlanningCapabilitySpec = {
  name: PlannedCapability;
  answers: string;
  requiredParams: string[];
  optionalParams: string[];
  outputView: string;
  allowedChainingInputs: string[];
  maxRows?: number;
  whenNotToUse: string[];
};

export type PlanValidationResult =
  | { ok: true; plan: ResearchPlan; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

export type MockExecutionStep = {
  stepId: string;
  capability: PlannedCapability;
  params: Record<string, unknown>;
  outputView: string;
};

export type MockExecutionResult = {
  steps: MockExecutionStep[];
  finalMockAnswer: {
    summary: string;
    rows: Array<Record<string, unknown>>;
    warnings: string[];
  };
};

export type ResearchPlanExecutionInput = {
  plan: ResearchPlan;
  message: string;
  classification: Classification;
  snapshots: SnapshotBundle;
  toolOutputs: ToolOutputs;
  pgCapabilityRunner?: (
    input: PgCapabilityRunInput,
  ) => Promise<PgCapabilityRunResult>;
  pipelineOverlayRunner?: (
    input: PipelineOverlayRunInput,
  ) => Promise<PipelineOverlayRunResult>;
};

export type ResearchPlanExecutionResult = {
  handled?: boolean;
  pgCapabilityViews?: PgCapabilityViews;
  pipelineOverlayViews?: PipelineOverlayViews;
  compoundResearchContext?: CompoundResearchContext;
  warnings: string[];
};

export type ResearchPlanExecutor = (
  input: ResearchPlanExecutionInput,
) => Promise<ResearchPlanExecutionResult>;

const ASK_GRAHAMY_ORG_ID =
  process.env.ASK_GRAHAMY_ORG_ID ?? "acf0cbab-3aed-42cf-872d-63cba24e61c3";

const PLANNER_MODEL =
  process.env.ASK_GRAHAMY_RESEARCH_PLANNER_MODEL ?? "claude-sonnet-4-5";

const MAX_STEPS = 4;
const MAX_SECTOR_CONSTRAINTS = 3;
const MAX_PIPELINE_SYMBOLS = 3;
const FORBIDDEN_TOKEN_PATTERN =
  /\b(raw\s*sql|sql|raw\s*rows?|table(?:s)?|edge_id|hypothesis_id|gates?|thresholds?|feature_rules?|sqlite|\.db|grahamy_discovery|pipeline_state|sentinel\s+rows?|coroner|stop[-\s]?loss|sizing|buy|sell)\b/i;

const planStepSchema = z.object({
  id: z.string().trim().min(1).max(60),
  capability: z.enum(PLANNABLE_CAPABILITIES),
  purpose: z.string().trim().min(1).max(300),
  params: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.array(z.string().trim().min(1).max(60)).max(4).optional(),
  paramsFromPreviousSteps: z
    .record(
      z.string(),
      z.object({
        stepId: z.string().trim().min(1).max(60),
        sourcePath: z.string().trim().min(1).max(160),
        transform: z.string().trim().min(1).max(80),
      }),
    )
    .optional(),
  optional: z.boolean().optional(),
});

export const researchPlanSchema = z.object({
  planType: z.enum(["single_step", "multi_step"]),
  steps: z.array(planStepSchema).min(1).max(MAX_STEPS),
  finalAnswerGoal: z.string().trim().min(1).max(160),
  expectedViews: z.array(z.string().trim().min(1).max(80)).max(8),
  safetyNotes: z.array(z.string().trim().min(1).max(180)).max(8),
});

export const PLANNING_CAPABILITY_REGISTRY: Record<
  PlannedCapability,
  PlanningCapabilitySpec
> = {
  stock_research_object: {
    name: "stock_research_object",
    answers: "Public stock Research Object analysis for explicit symbols.",
    requiredParams: ["symbol"],
    optionalParams: [],
    outputView: "researchObjectViews",
    allowedChainingInputs: ["featureScreenView.rows.symbol"],
    whenNotToUse: ["Do not use for broad stock screens."],
  },
  sector_research_object: {
    name: "sector_research_object",
    answers: "Public sector Research Object analysis for explicit sectors.",
    requiredParams: ["sector"],
    optionalParams: [],
    outputView: "researchObjectViews",
    allowedChainingInputs: ["explicit sector"],
    whenNotToUse: ["Do not use for broad sector rankings."],
  },
  regime_research_object: {
    name: "regime_research_object",
    answers: "Current market regime Research Object.",
    requiredParams: [],
    optionalParams: ["regime"],
    outputView: "researchObjectViews",
    allowedChainingInputs: ["current regime"],
    whenNotToUse: ["Do not use for historical regime sector playbooks."],
  },
  market_regime_historical_playbook: {
    name: "market_regime_historical_playbook",
    answers: "Historical sector leaders, laggards, and risk context in the current regime.",
    requiredParams: [],
    optionalParams: ["emphasis"],
    outputView: "regimeHistoricalPlaybookView",
    allowedChainingInputs: [],
    maxRows: 10,
    whenNotToUse: ["Do not use for current stock candidate rows by itself."],
  },
  sector_conviction_leaderboard: {
    name: "sector_conviction_leaderboard",
    answers: "Current sector conviction ranking.",
    requiredParams: [],
    optionalParams: ["rankingBasis"],
    outputView: "sectorLeaderboardView",
    allowedChainingInputs: [],
    maxRows: 10,
    whenNotToUse: ["Do not use for individual stock evidence."],
  },
  sector_momentum_vs_conviction_divergence: {
    name: "sector_momentum_vs_conviction_divergence",
    answers: "Sectors where conviction and momentum diverge.",
    requiredParams: [],
    optionalParams: [],
    outputView: "sectorDivergenceView",
    allowedChainingInputs: [],
    maxRows: 10,
    whenNotToUse: ["Do not invent divergence if rows are empty."],
  },
  week_over_week_sector_delta: {
    name: "week_over_week_sector_delta",
    answers: "Week-over-week sector changes.",
    requiredParams: [],
    optionalParams: ["rankingBasis"],
    outputView: "sectorDeltaView",
    allowedChainingInputs: [],
    maxRows: 10,
    whenNotToUse: ["Do not use if prior weekly baseline is missing."],
  },
  stock_idea_discovery: {
    name: "stock_idea_discovery",
    answers: "Broad current research candidates when the user does not specify filters.",
    requiredParams: [],
    optionalParams: ["rankingBasis"],
    outputView: "stockIdeaView",
    allowedChainingInputs: [],
    maxRows: 10,
    whenNotToUse: ["Do not use instead of feature_screen when user specifies criteria."],
  },
  feature_screen: {
    name: "feature_screen",
    answers: "Current stock screen using public feature buckets or sector constraints.",
    requiredParams: ["criteria or sectorConstraints"],
    optionalParams: ["maxRows"],
    outputView: "featureScreenView",
    allowedChainingInputs: [
      "regimeHistoricalPlaybookView.rows[role=leader].sector",
      "sectorLeaderboardView.rows.sector",
    ],
    maxRows: 10,
    whenNotToUse: ["Never run without bounded criteria or sector constraints."],
  },
  factor_conditioned_backtest: {
    name: "factor_conditioned_backtest",
    answers: "Historical outcome distribution for public factor combinations.",
    requiredParams: ["criteria", "horizon"],
    optionalParams: ["sector"],
    outputView: "factorBacktestView",
    allowedChainingInputs: ["featureScreenView.screenCriteria"],
    whenNotToUse: ["Do not use unsupported factors or unsupported horizons."],
  },
  comparison: {
    name: "comparison",
    answers: "Stock-vs-sector, sector-vs-sector, or symbol-vs-symbol comparison.",
    requiredParams: ["comparisonType", "left", "right"],
    optionalParams: [],
    outputView: "comparisonView",
    allowedChainingInputs: ["explicit comparison anchors"],
    whenNotToUse: ["Do not use for broad rankings or screens."],
  },
  risk_path: {
    name: "risk_path",
    answers: "Risk-focused answer from public pathRisk fields.",
    requiredParams: ["anchor"],
    optionalParams: [],
    outputView: "researchObjectViews.pathRisk",
    allowedChainingInputs: ["stock_research_object anchor"],
    whenNotToUse: ["Never substitute forward returns for drawdown risk."],
  },
  validated_edge_evidence: {
    name: "validated_edge_evidence",
    answers: "Public Pipeline validation overlay for explicit anchors or top candidates.",
    requiredParams: ["anchor or symbols"],
    optionalParams: ["topN"],
    outputView: "validatedEdgeEvidenceView",
    allowedChainingInputs: ["featureScreenView.rows.symbol"],
    maxRows: MAX_PIPELINE_SYMBOLS,
    whenNotToUse: ["Must be optional for PG candidate screens."],
  },
};

const PLANNER_SYSTEM_PROMPT = `You are Ask Grahamy's internal research planner.
Return a structured ResearchPlan only. Do not answer the user.

You may plan only these public capabilities:
${Object.values(PLANNING_CAPABILITY_REGISTRY)
  .map(
    (spec) =>
      `- ${spec.name}: ${spec.answers}; output=${spec.outputView}; bounds=${spec.maxRows ?? "bounded by executor"}`,
  )
  .join("\n")}

Planning rules:
- Use multi_step only when the user asks for compound research requiring more than one public view.
- Never request SQL, raw rows, table names, IDs, gates, thresholds, feature rules, SQLite, or Pipeline internals.
- feature_screen must have explicit public criteria or sectorConstraints from a prior public step.
- validated_edge_evidence is optional for stock candidate screens and must not block PG candidates.
- For current-regime sector-to-stock questions, prefer:
  market_regime_historical_playbook -> feature_screen constrained by leader sectors -> optional validated_edge_evidence for top candidates.
- Use sourcePath values only from public views.
- Allowed chaining examples:
  regimeHistoricalPlaybookView.rows[role=leader].sector -> feature_screen sectorConstraints with transform top_3_unique_sectors.
  sectorLeaderboardView.rows.sector -> feature_screen sectorConstraints with transform top_3_unique_sectors.
  featureScreenView.rows.symbol -> optional validated_edge_evidence symbols with transform top_3_symbols.
- finalAnswerGoal should describe the public analyst output, such as ranked_research_candidates.
Return only the structured ResearchPlan object.`;

type PlannerRunnable = {
  invoke: (msgs: Array<{ role: string; content: string }>) => Promise<unknown>;
};

let cachedPlanner: { apiKey: string; runnable: PlannerRunnable } | null = null;

export function buildPlannerPrompt(message: string): Array<{ role: string; content: string }> {
  return [
    { role: "system", content: PLANNER_SYSTEM_PROMPT },
    { role: "user", content: `User question:\n${message}` },
  ];
}

export function shouldRunResearchPlanner(
  message: string,
  classification: Classification,
): boolean {
  if (classification.focus === "risk" || classification.focus === "validated_evidence") {
    return false;
  }
  if (
    [
      "stock",
      "sector",
      "regime",
      "comparison",
      "feature_screen",
      "factor_conditioned_backtest",
      "stock_idea_discovery",
    ].includes(classification.intent)
  ) {
    return false;
  }

  const text = normalizeForPlanning(message);
  const asksAboutCurrentRegime =
    /\b(current market|market condition|market regime|this regime|current regime)\b/.test(
      text,
    ) ||
    /מצב\s+השוק|מצב\s+השוק\s+הנוכחי|מצב\s+הנוכחי|משטר\s+השוק|השוק\s+הנוכחי/.test(
      text,
    );
  const asksAboutHistoricalSectorStrength =
    /\b(historically strong sectors?|what works in this regime|sectors? historically (lead|work|strong))\b/.test(
      text,
    ) ||
    /סקטור(?:ים)?[^.?!]{0,40}(חזק|חזקים|מוביל|מובילים)|נוטה\s+להיות\s+חזק|מה\s+עובד/.test(
      text,
    );
  const asksForCurrentStocks =
    /\b(current stocks?|stock candidates?|names?|candidates?|what should i look at now|find .*stocks?)\b/.test(
      text,
    ) ||
    /מניות|מועמדים|שמות|משהו\s+נוכחי|מצא\s+לי|תמצא\s+לי|מה\s+לבחון\s+עכשיו/.test(
      text,
    );
  const asksForRecurringHistoricalSuccess =
    /\b(recurring historical success|historically strong|worked historically|repeated success|historical winners?)\b/.test(
      text,
    ) ||
    /היסטורית|היסטורי|הצלחות\s+חוזרות|הצלחה\s+חוזרת|חזקות/.test(text);

  return (
    asksAboutCurrentRegime &&
    asksForCurrentStocks &&
    (asksAboutHistoricalSectorStrength || asksForRecurringHistoricalSuccess)
  );
}

export async function proposeResearchPlan(message: string): Promise<ResearchPlan> {
  const vendor = await resolveOrgVendorByOrg(PLANNER_MODEL, ASK_GRAHAMY_ORG_ID);
  if (!vendor || !vendor.apiKey) {
    throw new Error("Ask Grahamy research planner model is unavailable.");
  }
  if (!cachedPlanner || cachedPlanner.apiKey !== vendor.apiKey) {
    const llm =
      vendor.vendorSlug === "anthropic"
        ? new ChatAnthropic({
            modelName: PLANNER_MODEL,
            apiKey: vendor.apiKey,
            ...(process.env.MERIDIAN_URL
              ? { anthropicApiUrl: process.env.MERIDIAN_URL }
              : {}),
            ...anthropicBaseConfig(),
          })
        : vendor.vendorSlug === "openai"
          ? new ChatOpenAI({ modelName: PLANNER_MODEL, apiKey: vendor.apiKey })
          : null;
    if (!llm) {
      throw new Error(
        `Ask Grahamy research planner does not support vendor ${vendor.vendorSlug}.`,
      );
    }
    cachedPlanner = {
      apiKey: vendor.apiKey,
      runnable: (llm as unknown as {
        withStructuredOutput: (
          schema: typeof researchPlanSchema,
          opts: { name: string },
        ) => PlannerRunnable;
      }).withStructuredOutput(researchPlanSchema, {
        name: "ask_grahamy_research_plan",
      }),
    };
  }
  const raw = await cachedPlanner.runnable.invoke(buildPlannerPrompt(message));
  return parseResearchPlan(raw);
}

export function parseResearchPlan(raw: unknown): ResearchPlan {
  return researchPlanSchema.parse(raw);
}

export function validateResearchPlan(plan: ResearchPlan): PlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const normalized = parseResearchPlan(plan);
  const stepIds = new Set<string>();

  if (normalized.steps.length > MAX_STEPS) {
    errors.push(`Plan has too many steps; max is ${MAX_STEPS}.`);
  }

  for (const step of normalized.steps) {
    if (stepIds.has(step.id)) errors.push(`Duplicate step id: ${step.id}.`);
    stepIds.add(step.id);
    if (!PLANNING_CAPABILITY_REGISTRY[step.capability]) {
      errors.push(`Unsupported capability: ${step.capability}.`);
    }
    assertNoForbiddenFields(step, `step ${step.id}`, errors);
    for (const dep of step.dependsOn ?? []) {
      if (!normalized.steps.some((candidate) => candidate.id === dep)) {
        errors.push(`Step ${step.id} depends on unknown step ${dep}.`);
      }
    }
    for (const [paramName, source] of Object.entries(step.paramsFromPreviousSteps ?? {})) {
      if (!normalized.steps.some((candidate) => candidate.id === source.stepId)) {
        errors.push(`Step ${step.id} references unknown source step ${source.stepId}.`);
      }
      if (!isAllowedSourcePath(source.sourcePath)) {
        errors.push(`Step ${step.id} uses unsafe source path for ${paramName}.`);
      }
      if (!isAllowedTransform(source.transform)) {
        errors.push(`Step ${step.id} uses unsupported transform for ${paramName}.`);
      }
    }
    validateCapabilitySpecificRules(step, normalized, errors, warnings);
  }

  assertNoForbiddenFields(
    {
      finalAnswerGoal: normalized.finalAnswerGoal,
      expectedViews: normalized.expectedViews,
      safetyNotes: normalized.safetyNotes,
    },
    "plan",
    errors,
  );

  return errors.length
    ? { ok: false, errors: [...new Set(errors)], warnings: [...new Set(warnings)] }
    : { ok: true, plan: normalized, warnings: [...new Set(warnings)] };
}

export function executeMockResearchPlan(input: {
  plan: ResearchPlan;
  fixtureOutputs: Record<string, unknown>;
}): MockExecutionResult {
  const validation = validateResearchPlan(input.plan);
  if (!validation.ok) {
    throw new Error(`Invalid mock research plan: ${validation.errors.join("; ")}`);
  }
  const outputs: Record<string, unknown> = {};
  const steps: MockExecutionStep[] = [];
  const warnings: string[] = [];

  for (const step of validation.plan.steps) {
    const params = resolveMockParams(step, outputs);
    const fixture = input.fixtureOutputs[step.id];
    outputs[step.id] = fixture;
    if (!fixture && !step.optional) {
      warnings.push(`Required step ${step.id} had no fixture output.`);
    }
    steps.push({
      stepId: step.id,
      capability: step.capability,
      params,
      outputView: PLANNING_CAPABILITY_REGISTRY[step.capability].outputView,
    });
  }

  return {
    steps,
    finalMockAnswer: buildMockAnswer(steps, outputs, warnings),
  };
}

function validateCapabilitySpecificRules(
  step: ResearchPlanStep,
  plan: ResearchPlan,
  errors: string[],
  warnings: string[],
): void {
  if (step.capability === "feature_screen") {
    const criteria = arrayParam(step.params.criteria);
    const sectorConstraints = arrayParam(step.params.sectorConstraints);
    const sectorConstraintFromPreviousStep = Object.values(
      step.paramsFromPreviousSteps ?? {},
    ).some((source) =>
      /regimeHistoricalPlaybookView\.rows|sectorLeaderboardView\.rows/.test(
        source.sourcePath,
      ),
    );
    if (!criteria.length && !sectorConstraints.length && !sectorConstraintFromPreviousStep) {
      errors.push("feature_screen must have bounded criteria or sector constraints.");
    }
    if (sectorConstraints.length > MAX_SECTOR_CONSTRAINTS) {
      errors.push(`feature_screen sector constraints exceed max ${MAX_SECTOR_CONSTRAINTS}.`);
    }
  }

  if (step.capability === "factor_conditioned_backtest") {
    const criteria = arrayParam(step.params.criteria);
    if (!criteria.length) errors.push("factor_conditioned_backtest requires criteria.");
    const horizon = typeof step.params.horizon === "string" ? step.params.horizon : "60-day";
    if (!["20-day", "40-day", "60-day", "120-day", "252-day"].includes(horizon)) {
      errors.push("factor_conditioned_backtest uses unsupported horizon.");
    }
  }

  if (step.capability === "validated_edge_evidence") {
    const goal = plan.finalAnswerGoal.toLowerCase();
    if (goal.includes("candidate") && step.optional !== true) {
      errors.push("validated_edge_evidence must be optional for PG candidate output.");
    }
    const topN = numberParam(step.params.topN);
    if (topN != null && topN > MAX_PIPELINE_SYMBOLS) {
      errors.push(`validated_edge_evidence topN exceeds max ${MAX_PIPELINE_SYMBOLS}.`);
    }
  }

  if (step.optional) {
    warnings.push(`Optional step ${step.id} may be skipped if unavailable.`);
  }
}

function assertNoForbiddenFields(value: unknown, context: string, errors: string[]): void {
  const json = JSON.stringify(value);
  if (FORBIDDEN_TOKEN_PATTERN.test(json)) {
    errors.push(`${context} requests forbidden internal data.`);
  }
}

function isAllowedSourcePath(sourcePath: string): boolean {
  return [
    /^regimeHistoricalPlaybookView\.rows\[role=leader\]\.sector$/,
    /^sectorLeaderboardView\.rows\.sector$/,
    /^featureScreenView\.rows\.symbol$/,
    /^featureScreenView\.screenCriteria$/,
    /^comparisonView$/,
  ].some((pattern) => pattern.test(sourcePath));
}

function isAllowedTransform(transform: string): boolean {
  return [
    "top_3_unique_sectors",
    "top_3_symbols",
    "top_10_rows",
    "public_criteria_only",
  ].includes(transform);
}

function resolveMockParams(
  step: ResearchPlanStep,
  outputs: Record<string, unknown>,
): Record<string, unknown> {
  const params = { ...step.params };
  for (const [paramName, source] of Object.entries(step.paramsFromPreviousSteps ?? {})) {
    params[paramName] = extractMockValue(outputs[source.stepId], source.sourcePath, source.transform);
  }
  return params;
}

function extractMockValue(
  output: unknown,
  sourcePath: string,
  transform: string,
): unknown {
  if (sourcePath === "regimeHistoricalPlaybookView.rows[role=leader].sector") {
    const rows = rowsFromView(output, "regimeHistoricalPlaybookView");
    const sectors = rows
      .filter((row) => row.role === "leader" && typeof row.sector === "string")
      .map((row) => String(row.sector));
    return unique(sectors).slice(0, transform === "top_3_unique_sectors" ? 3 : undefined);
  }
  if (sourcePath === "sectorLeaderboardView.rows.sector") {
    const rows = rowsFromView(output, "sectorLeaderboardView");
    return unique(rows.map((row) => row.sector).filter(stringGuard)).slice(0, 3);
  }
  if (sourcePath === "featureScreenView.rows.symbol") {
    const rows = rowsFromView(output, "featureScreenView");
    return unique(rows.map((row) => row.symbol).filter(stringGuard)).slice(
      0,
      transform === "top_3_symbols" ? 3 : undefined,
    );
  }
  if (sourcePath === "featureScreenView.screenCriteria") {
    return objectView(output, "featureScreenView")?.screenCriteria ?? [];
  }
  return undefined;
}

function rowsFromView(output: unknown, viewKey: string): Array<Record<string, unknown>> {
  const view = objectView(output, viewKey);
  return Array.isArray(view?.rows) ? view.rows.filter(isRecord) : [];
}

function objectView(output: unknown, viewKey: string): Record<string, unknown> | undefined {
  if (!isRecord(output)) return undefined;
  const nested = output[viewKey];
  if (isRecord(nested)) return nested;
  return output;
}

function buildMockAnswer(
  steps: MockExecutionStep[],
  outputs: Record<string, unknown>,
  warnings: string[],
): MockExecutionResult["finalMockAnswer"] {
  const featureStep = steps.find((step) => step.capability === "feature_screen");
  const featureOutput = featureStep ? outputs[featureStep.stepId] : undefined;
  const candidateRows = rowsFromView(featureOutput, "featureScreenView").slice(0, 10);
  return {
    summary:
      "Mock answer: ran the validated research plan and would answer from public views only.",
    rows: candidateRows.map((row) => ({
      symbol: row.symbol,
      sector: row.sector,
      hitRatePct: row.hitRatePct,
      medianReturnPct: row.medianReturnPct,
      pipeline: "not_available_in_this_turn",
    })),
    warnings,
  };
}

export async function executeResearchPlan(
  input: ResearchPlanExecutionInput,
): Promise<ResearchPlanExecutionResult> {
  const validation = validateResearchPlan(input.plan);
  if (!validation.ok) {
    return {
      handled: false,
      warnings: [
        "The compound research request could not be safely expanded into bounded checks.",
      ],
    };
  }
  const planShape = supportedRegimeToStockScreenPlan(validation.plan);
  if (!planShape) {
    return {
      handled: false,
      warnings: [
        "The requested multi-step research plan is outside the currently supported bounded execution path.",
      ],
    };
  }

  const warnings: string[] = [];
  const regimeResult = await runPlannerPgCapability(input, {
    ...baseClassification(input.classification),
    intent: "market_regime_historical_playbook",
    symbols: [],
    sectors: [],
    regimeRequested: false,
    featureCriteria: undefined,
    factorBacktest: undefined,
    comparison: undefined,
    focus: undefined,
  });
  warnings.push(...regimeResult.warnings);
  const regimeView = regimeResult.views.regimeHistoricalPlaybookView;
  if (!regimeView || regimeView.state === "unavailable") {
    warnings.push(
      "Historical sector leadership in the current regime is unavailable, so current stock screening was not run.",
    );
    return {
      handled: true,
      pgCapabilityViews: regimeResult.views,
      warnings: unique(warnings),
    };
  }

  const leadingSectors = extractLeaderSectors(regimeView);
  if (!leadingSectors.length) {
    warnings.push(
      "No historically leading sectors were available in the current regime view, so current stock screening was not run.",
    );
    return {
      handled: true,
      pgCapabilityViews: { regimeHistoricalPlaybookView: regimeView },
      compoundResearchContext: {
        planType: "regime_sector_to_stock_screen",
        leadingSectors: [],
        featureScreenCriteria: [],
        candidatePipelineLabels: {},
        warnings: unique(warnings),
      },
      warnings: unique(warnings),
    };
  }

  const screenResults = await runSectorFeatureScreens(input, leadingSectors);
  warnings.push(...screenResults.warnings);
  const pipelineLabels = planShape.pipelineStep
    ? await runOptionalCandidatePipelineLabels(input, screenResults.view.rows)
    : { labels: {}, warnings: [] };
  warnings.push(...pipelineLabels.warnings);

  return {
    handled: true,
    pgCapabilityViews: {
      regimeHistoricalPlaybookView: regimeView,
      featureScreenView: screenResults.view,
    },
    compoundResearchContext: {
      planType: "regime_sector_to_stock_screen",
      leadingSectors,
      featureScreenCriteria: screenResults.view.screenCriteria,
      candidatePipelineLabels: pipelineLabels.labels,
      warnings: unique(warnings),
    },
    warnings: unique(warnings),
  };
}

function supportedRegimeToStockScreenPlan(
  plan: ResearchPlan,
): { pipelineStep?: ResearchPlanStep } | undefined {
  if (plan.planType !== "multi_step") return undefined;
  if (plan.steps.length < 2 || plan.steps.length > 3) return undefined;
  const [regimeStep, featureStep, pipelineStep] = plan.steps;
  if (regimeStep.capability !== "market_regime_historical_playbook") {
    return undefined;
  }
  if (featureStep.capability !== "feature_screen") return undefined;
  const featureSources = Object.values(featureStep.paramsFromPreviousSteps ?? {});
  const usesLeaderSectorSource = featureSources.some(
    (source) =>
      source.stepId === regimeStep.id &&
      source.sourcePath ===
        "regimeHistoricalPlaybookView.rows[role=leader].sector" &&
      source.transform === "top_3_unique_sectors",
  );
  if (!usesLeaderSectorSource) return undefined;
  if (!pipelineStep) return {};
  if (
    pipelineStep.capability !== "validated_edge_evidence" ||
    pipelineStep.optional !== true
  ) {
    return undefined;
  }
  const pipelineSources = Object.values(pipelineStep.paramsFromPreviousSteps ?? {});
  const usesTopSymbolsSource = pipelineSources.some(
    (source) =>
      source.stepId === featureStep.id &&
      source.sourcePath === "featureScreenView.rows.symbol" &&
      source.transform === "top_3_symbols",
  );
  return usesTopSymbolsSource ? { pipelineStep } : undefined;
}

async function runPlannerPgCapability(
  input: ResearchPlanExecutionInput,
  classification: Classification,
): Promise<PgCapabilityRunResult> {
  const result = await executePgCapabilitiesWithCache(
    {
      classification,
      message: input.message,
      snapshots: input.snapshots,
      toolOutputs: input.toolOutputs,
    },
    [],
    input.pgCapabilityRunner,
  );
  return { views: result.views, warnings: result.warnings };
}

function baseClassification(classification: Classification): Classification {
  return {
    intent: classification.intent,
    symbols: [],
    sectors: [],
    regimeRequested: false,
    isFollowUp: false,
    requiresTools: classification.requiresTools ?? [],
    confidence: classification.confidence,
    warnings: [],
  };
}

function extractLeaderSectors(
  view: PgCapabilityViews["regimeHistoricalPlaybookView"],
): string[] {
  if (!view) return [];
  return unique(
    [...view.rows]
      .filter((row) => row.role === "leader" && typeof row.sector === "string")
      .sort((left, right) => numberSortValue(left.rank) - numberSortValue(right.rank))
      .map((row) => row.sector),
  ).slice(0, MAX_SECTOR_CONSTRAINTS);
}

async function runSectorFeatureScreens(
  input: ResearchPlanExecutionInput,
  sectors: string[],
): Promise<{ view: FeatureScreenView; warnings: string[] }> {
  const warnings: string[] = [];
  const views: FeatureScreenView[] = [];
  for (const sector of sectors.slice(0, MAX_SECTOR_CONSTRAINTS)) {
    const criteria: FeatureScreenCriterion[] = [{ factor: "sector", bucket: sector }];
    try {
      const result = await runPlannerPgCapability(input, {
        ...baseClassification(input.classification),
        intent: "feature_screen",
        featureCriteria: criteria,
        symbols: [],
        sectors: [],
        regimeRequested: false,
        factorBacktest: undefined,
        comparison: undefined,
        focus: undefined,
      });
      warnings.push(...result.warnings);
      if (result.views.featureScreenView) {
        views.push(result.views.featureScreenView);
      } else {
        warnings.push(`Current stock screening was unavailable for ${sector}.`);
      }
    } catch (err) {
      logger.warn("Ask Grahamy compound feature screen step failed", {
        sector,
        error: err instanceof Error ? err.message : String(err),
      });
      warnings.push(`Current stock screening was unavailable for ${sector}.`);
    }
  }
  return { view: mergeFeatureScreenViews(sectors, views), warnings: unique(warnings) };
}

function mergeFeatureScreenViews(
  sectors: string[],
  views: FeatureScreenView[],
): FeatureScreenView {
  const criteria = sectors
    .slice(0, MAX_SECTOR_CONSTRAINTS)
    .map((sector): FeatureScreenCriterion => ({ factor: "sector", bucket: sector }));
  const warnings = unique([
    "These are screen results to review, not buy/sell recommendations.",
    "The screen is constrained to historically leading sectors from the current regime playbook.",
    ...views.flatMap((view) => view.warnings),
  ]);
  const rows = dedupeAndRankRows(views.flatMap((view) => view.rows)).slice(0, 10);
  const sawAvailableView = views.some((view) => view.state !== "unavailable");
  const hasPartialView = views.some((view) => view.state !== "complete");
  const asOfDate = latestString(views.map((view) => view.asOfDate).filter(stringGuard));
  const freshness =
    views.find((view) => view.freshness?.state === "fresh")?.freshness ??
    views.find((view) => view.freshness?.state === "stale")?.freshness ??
    views.find((view) => view.freshness)?.freshness ??
    { state: "unknown" as const };

  return {
    viewSchemaVersion: 1,
    state: rows.length
      ? hasPartialView
        ? "partial"
        : "complete"
      : sawAvailableView
        ? "complete"
        : "unavailable",
    source: "pg_current_features",
    asOfDate,
    screenCriteria: criteria,
    rows,
    freshness,
    warnings: rows.length
      ? warnings
      : unique([...warnings, "No current stock candidates matched the sector-constrained screen."]),
  };
}

function dedupeAndRankRows(rows: FeatureScreenRowView[]): FeatureScreenRowView[] {
  const bySymbol = new Map<string, FeatureScreenRowView>();
  for (const row of rows) {
    const symbol = row.symbol?.toUpperCase();
    if (!symbol) continue;
    const existing = bySymbol.get(symbol);
    if (!existing || compareFeatureRows(row, existing) < 0) {
      bySymbol.set(symbol, { ...row, symbol });
    }
  }
  return [...bySymbol.values()]
    .sort(compareFeatureRows)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function compareFeatureRows(
  left: FeatureScreenRowView,
  right: FeatureScreenRowView,
): number {
  return (
    numberSortValue(left.rank) - numberSortValue(right.rank) ||
    numberSortValue(right.hitRatePct, -Infinity) -
      numberSortValue(left.hitRatePct, -Infinity) ||
    numberSortValue(right.medianReturnPct, -Infinity) -
      numberSortValue(left.medianReturnPct, -Infinity) ||
    left.symbol.localeCompare(right.symbol)
  );
}

async function runOptionalCandidatePipelineLabels(
  input: ResearchPlanExecutionInput,
  rows: FeatureScreenRowView[],
): Promise<{ labels: Record<string, string>; warnings: string[] }> {
  const warnings: string[] = [];
  const labels: Record<string, string> = {};
  const symbols = unique(
    rows
      .map((row) => row.symbol)
      .filter(stringGuard)
      .map((symbol) => symbol.toUpperCase()),
  ).slice(0, MAX_PIPELINE_SYMBOLS);

  for (const symbol of symbols) {
    try {
      const result = await (input.pipelineOverlayRunner ?? executePipelineOverlays)({
        classification: {
          ...baseClassification(input.classification),
          intent: "stock",
          symbols: [symbol],
          sectors: [],
          regimeRequested: false,
          focus: "validated_evidence",
          featureCriteria: undefined,
          factorBacktest: undefined,
          comparison: undefined,
        },
        message: input.message,
      });
      warnings.push(...result.warnings);
      labels[symbol] = publicPipelineLabel(
        result.views.validatedEdgeEvidenceView,
      );
    } catch (err) {
      logger.warn("Ask Grahamy optional Pipeline validation step failed", {
        symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      labels[symbol] = "לא זמין בתור הזה";
      warnings.push(`Pipeline validation was unavailable for ${symbol}.`);
    }
  }
  return { labels, warnings: unique(warnings) };
}

function publicPipelineLabel(view: ValidatedEdgeEvidenceView | undefined): string {
  switch (view?.evidenceState) {
    case "edge_evidence_strong":
      return "ראיה מאומתת חזקה";
    case "edge_evidence_present":
      return "ראיה מאומתת קיימת";
    case "mixed":
      return "ראיה מעורבת";
    case "insufficient_data":
      return "אין מספיק ראיה";
    default:
      return "לא זמין בתור הזה";
  }
}

function arrayParam(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberParam(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberSortValue(value: unknown, fallback = Infinity): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function latestString(values: string[]): string | undefined {
  return values.sort().at(-1);
}

function unique<T>(values: T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function normalizeForPlanning(message: string): string {
  return message
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[־–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function stringGuard(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function safeProposeResearchPlan(
  message: string,
): Promise<PlanValidationResult> {
  try {
    return validateResearchPlan(await proposeResearchPlan(message));
  } catch (err) {
    logger.warn("Ask Grahamy research planner failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      errors: ["Research planner unavailable."],
      warnings: [],
    };
  }
}
