import { logger } from "../logger";
import type {
  CachedResearchObject,
  Classification,
  FactorBacktestCriterion,
  FactorBacktestHorizon,
  FeatureScreenCriterion,
  FeatureScreenRowView,
  FeatureScreenView,
  CompoundResearchContext,
  CompoundResearchWorkflowName,
  PgCapabilityViews,
  PipelineOverlayViews,
  SnapshotBundle,
  ToolOutputs,
  ValidatedEdgeEvidenceView,
} from "./types";
import {
  buildResearchObjects,
  type ResearchObjectBuildResult,
} from "./researchObjectBuilder";
import {
  executePgCapabilitiesWithCache,
} from "./pgCapabilities/registry";
import { executePipelineOverlays } from "./pipelineOverlays/registry";
import { buildWorkflowExecutionResult } from "./workflowExecution";
import type { WorkflowExecutionResult } from "./analystTypes";
import type {
  CachedCapabilityView,
  PgCapabilityRunInput,
  PgCapabilityRunResult,
} from "./pgCapabilities/types";
import type {
  PipelineOverlayRunInput,
  PipelineOverlayRunResult,
} from "./pipelineOverlays/registry";

/**
 * The 12 PG capabilities + research-object kinds the executors compose into
 * cascade plans. This is the closed enum used by `ResearchPlanStep.capability`.
 *
 * The set used to be enforced at runtime against an LLM-proposed plan; now
 * plans are built deterministically from `buildResearchWorkflowPlan` and the
 * runtime registry that constrained the LLM is gone.
 */
export type PlannedCapability =
  | "stock_research_object"
  | "sector_research_object"
  | "regime_research_object"
  | "market_regime_historical_playbook"
  | "sector_conviction_leaderboard"
  | "sector_momentum_vs_conviction_divergence"
  | "week_over_week_sector_delta"
  | "stock_idea_discovery"
  | "feature_screen"
  | "factor_conditioned_backtest"
  | "risk_path"
  | "validated_edge_evidence";

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

/**
 * Alias of the canonical workflow name union from `types.ts`. Re-exported
 * here so call sites inside the planner module read naturally.
 */
export type ResearchWorkflowName = CompoundResearchWorkflowName;

/**
 * Compact handle the executors operate on: the workflow name plus the
 * deterministic step list built by `buildResearchWorkflowPlan`. The original
 * shape also carried an LLM-validation `spec`, which is no longer needed.
 */
export type ResearchWorkflowMatch = {
  workflowName: ResearchWorkflowName;
  steps: ResearchPlanStep[];
};

export type ResearchPlanExecutionInput = {
  workflowName: ResearchWorkflowName;
  plan: ResearchPlan;
  message: string;
  classification: Classification;
  snapshots: SnapshotBundle;
  toolOutputs: ToolOutputs;
  priorResearchObjects?: CachedResearchObject[];
  researchObjectBuilder?: (input: {
    classification: Classification;
    snapshots: SnapshotBundle;
    toolOutputs: ToolOutputs;
    priorResearchObjects?: CachedResearchObject[];
  }) => Promise<ResearchObjectBuildResult>;
  pgCapabilityRunner?: (
    input: PgCapabilityRunInput,
  ) => Promise<PgCapabilityRunResult>;
  pipelineOverlayRunner?: (
    input: PipelineOverlayRunInput,
  ) => Promise<PipelineOverlayRunResult>;
};

export type ResearchPlanExecutionResult = {
  handled?: boolean;
  researchObjects?: CachedResearchObject[];
  researchObjectsUpdated?: CachedResearchObject[];
  researchObjectCacheStats?: { hits: number; misses: number; writes: number };
  pgCapabilityViews?: PgCapabilityViews;
  // Capability views built/refreshed during this turn that need persistence
  // by SS into `cached_capability_views`. Compound (planner-handled) flows
  // run their PG capabilities through `executePgCapabilitiesWithCache` just
  // like the standard path — the freshly built views must be threaded back
  // here so SS persists them. Empty array means "nothing new this turn".
  capabilityViewsUpdated?: CachedCapabilityView[];
  capabilityViewCacheStats?: { hits: number; misses: number; writes: number };
  pipelineOverlayViews?: PipelineOverlayViews;
  workflowExecutionResult?: WorkflowExecutionResult;
  compoundResearchContext?: CompoundResearchContext;
  warnings: string[];
};

export type ResearchPlanExecutor = (
  input: ResearchPlanExecutionInput,
) => Promise<ResearchPlanExecutionResult>;

/**
 * Bounds applied by individual executors. These were previously also enforced
 * by the LLM-plan validator that no longer exists; the executors keep them
 * because they cap the actual cascade fan-out (e.g. how many sectors to fan
 * a feature_screen across), not just the plan shape.
 */
const MAX_SECTOR_CONSTRAINTS = 3;
const MAX_CANDIDATES = 10;
const MAX_PIPELINE_SYMBOLS = 3;


/**
 * Build a research plan for a known workflow name. The classifier names the
 * workflow (`classification.compoundWorkflow`) and we render the matching
 * approved plan deterministically — no regex, no LLM call.
 *
 * `message` is used only to extract a stock symbol when the workflow is
 * `stock_deep_dive_stack` and the caller didn't already supply one.
 */
export function buildResearchWorkflowPlan(
  workflowName: ResearchWorkflowName,
  message: string,
): ResearchPlan {
  return planForWorkflow(workflowName, message);
}

function planForWorkflow(
  workflowName: ResearchWorkflowName,
  message: string,
): ResearchPlan {
  switch (workflowName) {
    case "regime_to_stock_screen":
      return workflowPlan({
        workflowName,
        steps: [
          { id: "regime_context", capability: "market_regime_historical_playbook", purpose: "Identify historically leading sectors in the current regime.", params: {} },
          sectorConstrainedScreenStep("regime_context", "regimeHistoricalPlaybookView.rows[role=leader].sector"),
          pipelineCheckStep("current_candidates"),
        ],
        expectedViews: ["regimeHistoricalPlaybookView", "featureScreenView", "validatedEdgeEvidenceView"],
      });
    case "sector_delta_to_stock_screen":
      return workflowPlan({
        workflowName,
        steps: [
          { id: "sector_delta", capability: "week_over_week_sector_delta", purpose: "Identify sectors that improved this week.", params: {} },
          sectorConstrainedScreenStep(
            "sector_delta",
            "sectorDeltaView.rows[direction=improved].sector",
            "top_3_improved_sectors",
          ),
          pipelineCheckStep("current_candidates"),
        ],
        expectedViews: ["sectorDeltaView", "featureScreenView", "validatedEdgeEvidenceView"],
      });
    case "sector_divergence_to_stock_screen":
      return workflowPlan({
        workflowName,
        steps: [
          { id: "sector_divergence", capability: "sector_momentum_vs_conviction_divergence", purpose: "Identify public conviction-versus-price divergence sectors.", params: {} },
          sectorConstrainedScreenStep(
            "sector_divergence",
            "sectorDivergenceView.rows.sector",
            "top_3_divergence_sectors",
          ),
          pipelineCheckStep("current_candidates"),
        ],
        expectedViews: ["sectorDivergenceView", "featureScreenView", "validatedEdgeEvidenceView"],
      });
    case "feature_screen_plus_backtest":
      return workflowPlan({
        workflowName,
        steps: [
          {
            id: "current_screen",
            capability: "feature_screen",
            purpose: "Find current stocks matching the public criteria.",
            params: {
              criteria: [
                { factor: "valuation", bucket: "ATTRACTIVE" },
                { factor: "quality", bucket: "STRONG" },
              ],
            },
          },
          {
            id: "aggregate_backtest",
            capability: "factor_conditioned_backtest",
            purpose: "Check aggregate historical evidence for the same public criteria.",
            params: { horizon: "60-day" },
            dependsOn: ["current_screen"],
            paramsFromPreviousSteps: {
              criteria: {
                stepId: "current_screen",
                sourcePath: "featureScreenView.screenCriteria",
                transform: "public_criteria_only",
              },
            },
          },
        ],
        expectedViews: ["featureScreenView", "factorBacktestView"],
      });
    case "stock_deep_dive_stack": {
      const symbol = extractSymbol(message);
      return workflowPlan({
        workflowName,
        steps: [
          { id: "stock_context", capability: "stock_research_object", purpose: "Load public stock Research Object.", params: symbol ? { symbol } : {} },
          { id: "sector_context", capability: "sector_research_object", purpose: "Load the sibling sector Research Object so the agent can compare side-by-side.", params: {}, dependsOn: ["stock_context"], optional: true },
          { id: "risk_context", capability: "risk_path", purpose: "Add public risk evidence for the stock.", params: {}, dependsOn: ["stock_context"] },
          pipelineCheckStep("stock_context", true),
        ],
        expectedViews: ["researchObjectViews", "validatedEdgeEvidenceView"],
      });
    }
    case "idea_to_compare_and_risk":
      return workflowPlan({
        workflowName,
        steps: [
          { id: "idea", capability: "stock_idea_discovery", purpose: "Find a public research candidate.", params: {} },
          { id: "sector_context", capability: "sector_research_object", purpose: "Load the sibling sector Research Object for the top candidate so the agent can compare side-by-side.", params: {}, dependsOn: ["idea"], optional: true },
          { id: "risk_context", capability: "risk_path", purpose: "Add public risk evidence for the top candidate.", params: {}, dependsOn: ["idea"] },
          pipelineCheckStep("idea", true),
        ],
        expectedViews: ["stockIdeaView", "researchObjectViews", "validatedEdgeEvidenceView"],
      });
  }
}

function workflowPlan(input: {
  workflowName: ResearchWorkflowName;
  steps: ResearchPlanStep[];
  expectedViews: string[];
}): ResearchPlan {
  return {
    planType: "multi_step",
    steps: input.steps,
    finalAnswerGoal:
      input.workflowName.endsWith("_to_stock_screen")
        ? "ranked_research_candidates"
        : input.workflowName,
    expectedViews: input.expectedViews,
    safetyNotes: ["Use public views only", "Do not invent assets", "Do not give action instructions"],
  };
}

function sectorConstrainedScreenStep(
  dependsOn: string,
  sourcePath: string,
  transform = "top_3_unique_sectors",
): ResearchPlanStep {
  return {
    id: "current_candidates",
    capability: "feature_screen",
    purpose: "Find current stock candidates constrained by public sector evidence.",
    params: {},
    dependsOn: [dependsOn],
    paramsFromPreviousSteps: {
      sectorConstraints: {
        stepId: dependsOn,
        sourcePath,
        transform,
      },
    },
  };
}

function pipelineCheckStep(dependsOn: string, anchorOnly = false): ResearchPlanStep {
  return {
    id: "pipeline_check",
    capability: "validated_edge_evidence",
    purpose: "Qualify public candidates with Pipeline evidence when available.",
    params: { topN: anchorOnly ? 1 : 3 },
    dependsOn: [dependsOn],
    paramsFromPreviousSteps: {
      symbols: {
        stepId: dependsOn,
        sourcePath: anchorOnly
          ? dependsOn === "idea"
            ? "stockIdeaView.rows[0].symbol"
            : "stock_research_object anchor"
          : "featureScreenView.rows.symbol",
        transform: anchorOnly ? "top_candidate_symbol" : "top_3_symbols",
      },
    },
    optional: true,
  };
}


function extractSymbol(message: string): string | undefined {
  const match = message.match(/\b[A-Z]{1,5}\b/);
  return match?.[0]?.toUpperCase();
}


/**
 * Should the planner node fire this turn? Single source of truth: the
 * classifier sets `classification.compoundWorkflow` when (and only when) the
 * user asked a compound multi-step question. For `stock_deep_dive_stack` we
 * also need an anchor symbol — either named in the classification or
 * extractable from the message.
 */
export function shouldRunResearchPlanner(
  message: string,
  classification: Classification,
): boolean {
  if (classification.focus === "validated_evidence") return false;
  if (!classification.compoundWorkflow) return false;
  if (classification.compoundWorkflow === "stock_deep_dive_stack") {
    return (
      classification.symbols.length === 1 || Boolean(extractSymbol(message))
    );
  }
  return true;
}


/**
 * Run the cascade for `input.workflowName`. The workflow name comes from the
 * classifier (`classification.compoundWorkflow`) and the plan from
 * `buildResearchWorkflowPlan` — both deterministic, so no validation is
 * needed here. We just synthesise the executor handle from the plan steps
 * and dispatch.
 */
export async function executeResearchPlan(
  input: ResearchPlanExecutionInput,
): Promise<ResearchPlanExecutionResult> {
  const workflow: ResearchWorkflowMatch = {
    workflowName: input.workflowName,
    steps: input.plan.steps,
  };

  switch (workflow.workflowName) {
    case "regime_to_stock_screen":
      return executeRegimeToStockScreen(input, workflow);
    case "sector_delta_to_stock_screen":
      return executeSectorDeltaToStockScreen(input, workflow);
    case "sector_divergence_to_stock_screen":
      return executeSectorDivergenceToStockScreen(input, workflow);
    case "feature_screen_plus_backtest":
      return executeFeatureScreenPlusBacktest(input, workflow);
    case "stock_deep_dive_stack":
      return executeStockDeepDiveStack(input, workflow);
    case "idea_to_compare_and_risk":
      return executeIdeaToCompareAndRisk(input, workflow);
  }
}

async function executeRegimeToStockScreen(
  input: ResearchPlanExecutionInput,
  workflow: ResearchWorkflowMatch,
): Promise<ResearchPlanExecutionResult> {
  const warnings: string[] = [];
  const capabilityViewsUpdated: CachedCapabilityView[] = [];
  const cacheStats = { hits: 0, misses: 0, writes: 0 };
  const regimeResult = await runPlannerPgCapability(input, capabilityClassification(
    input.classification,
    "market_regime_historical_playbook",
  ));
  warnings.push(...regimeResult.warnings);
  capabilityViewsUpdated.push(...regimeResult.viewsUpdated);
  cacheStats.hits += regimeResult.cacheStats.hits;
  cacheStats.misses += regimeResult.cacheStats.misses;
  cacheStats.writes += regimeResult.cacheStats.writes;
  const regimeView = regimeResult.views.regimeHistoricalPlaybookView;
  const sectors = extractLeaderSectors(regimeView);
  if (!regimeView || regimeView.state === "unavailable" || !sectors.length) {
    warnings.push(
      "Historical sector leadership in the current regime is unavailable, so current stock screening was not run.",
    );
    const screenView = emptySectorScreenView(sectors, "No historically leading sectors were available for a bounded stock screen.");
    return sectorScreenResult({
      workflowName: workflow.workflowName,
      pgCapabilityViews: {
        ...(regimeView ? { regimeHistoricalPlaybookView: regimeView } : regimeResult.views),
        featureScreenView: screenView,
      },
      sectors,
      screenView,
      pipelineLabels: {},
      warnings,
      capabilityViewsUpdated,
      capabilityViewCacheStats: cacheStats,
    });
  }
  const screenResults = await runSectorFeatureScreens(
    input,
    sectors,
    "The screen is constrained to sectors that historically led in the current regime playbook.",
  );
  warnings.push(...screenResults.warnings);
  capabilityViewsUpdated.push(...screenResults.capabilityViewsUpdated);
  cacheStats.hits += screenResults.capabilityViewCacheStats.hits;
  cacheStats.misses += screenResults.capabilityViewCacheStats.misses;
  cacheStats.writes += screenResults.capabilityViewCacheStats.writes;
  const pipelineLabels = hasOptionalPipelineStep(workflow)
    ? await runOptionalCandidatePipelineLabels(input, screenResults.view.rows)
    : { labels: {}, warnings: [] };
  warnings.push(...pipelineLabels.warnings);
  return sectorScreenResult({
    workflowName: workflow.workflowName,
    pgCapabilityViews: {
      regimeHistoricalPlaybookView: regimeView,
      featureScreenView: screenResults.view,
    },
    sectors,
    screenView: screenResults.view,
    pipelineLabels: pipelineLabels.labels,
    warnings,
    capabilityViewsUpdated,
    capabilityViewCacheStats: cacheStats,
  });
}

async function executeSectorDeltaToStockScreen(
  input: ResearchPlanExecutionInput,
  workflow: ResearchWorkflowMatch,
): Promise<ResearchPlanExecutionResult> {
  const warnings: string[] = [];
  const capabilityViewsUpdated: CachedCapabilityView[] = [];
  const cacheStats = { hits: 0, misses: 0, writes: 0 };
  const deltaResult = await runPlannerPgCapability(input, capabilityClassification(
    input.classification,
    "week_over_week_sector_delta",
  ));
  warnings.push(...deltaResult.warnings);
  capabilityViewsUpdated.push(...deltaResult.viewsUpdated);
  cacheStats.hits += deltaResult.cacheStats.hits;
  cacheStats.misses += deltaResult.cacheStats.misses;
  cacheStats.writes += deltaResult.cacheStats.writes;
  const deltaView = deltaResult.views.sectorDeltaView;
  const sectors = extractImprovedSectors(deltaView);
  if (!deltaView || deltaView.state === "unavailable" || !sectors.length) {
    warnings.push(
      "No improved sectors were available in the weekly sector delta view, so current stock screening was not run.",
    );
    const screenView = emptySectorScreenView(sectors, "No improved sectors were available for a bounded stock screen.");
    return sectorScreenResult({
      workflowName: workflow.workflowName,
      pgCapabilityViews: {
        ...(deltaView ? { sectorDeltaView: deltaView } : deltaResult.views),
        featureScreenView: screenView,
      },
      sectors,
      screenView,
      pipelineLabels: {},
      warnings,
      capabilityViewsUpdated,
      capabilityViewCacheStats: cacheStats,
    });
  }
  const screenResults = await runSectorFeatureScreens(
    input,
    sectors,
    "The screen is constrained to sectors that improved in the weekly public sector delta view.",
  );
  warnings.push(...screenResults.warnings);
  capabilityViewsUpdated.push(...screenResults.capabilityViewsUpdated);
  cacheStats.hits += screenResults.capabilityViewCacheStats.hits;
  cacheStats.misses += screenResults.capabilityViewCacheStats.misses;
  cacheStats.writes += screenResults.capabilityViewCacheStats.writes;
  const pipelineLabels = hasOptionalPipelineStep(workflow)
    ? await runOptionalCandidatePipelineLabels(input, screenResults.view.rows)
    : { labels: {}, warnings: [] };
  warnings.push(...pipelineLabels.warnings);
  return sectorScreenResult({
    workflowName: workflow.workflowName,
    pgCapabilityViews: { sectorDeltaView: deltaView, featureScreenView: screenResults.view },
    sectors,
    screenView: screenResults.view,
    pipelineLabels: pipelineLabels.labels,
    warnings,
    capabilityViewsUpdated,
    capabilityViewCacheStats: cacheStats,
  });
}

async function executeSectorDivergenceToStockScreen(
  input: ResearchPlanExecutionInput,
  workflow: ResearchWorkflowMatch,
): Promise<ResearchPlanExecutionResult> {
  const warnings: string[] = [];
  const capabilityViewsUpdated: CachedCapabilityView[] = [];
  const cacheStats = { hits: 0, misses: 0, writes: 0 };
  const divergenceResult = await runPlannerPgCapability(input, capabilityClassification(
    input.classification,
    "sector_momentum_vs_conviction_divergence",
  ));
  warnings.push(...divergenceResult.warnings);
  capabilityViewsUpdated.push(...divergenceResult.viewsUpdated);
  cacheStats.hits += divergenceResult.cacheStats.hits;
  cacheStats.misses += divergenceResult.cacheStats.misses;
  cacheStats.writes += divergenceResult.cacheStats.writes;
  const divergenceView = divergenceResult.views.sectorDivergenceView;
  const sectors = extractDivergenceSectors(divergenceView);
  if (!divergenceView || divergenceView.state === "unavailable" || !sectors.length) {
    warnings.push(
      "No clear conviction-versus-price divergence sectors were available, so current stock screening was not run.",
    );
    const screenView = emptySectorScreenView(sectors, "No divergence sectors were available for a bounded stock screen.");
    return sectorScreenResult({
      workflowName: workflow.workflowName,
      pgCapabilityViews: {
        ...(divergenceView ? { sectorDivergenceView: divergenceView } : divergenceResult.views),
        featureScreenView: screenView,
      },
      sectors,
      screenView,
      pipelineLabels: {},
      warnings,
      capabilityViewsUpdated,
      capabilityViewCacheStats: cacheStats,
    });
  }
  const screenResults = await runSectorFeatureScreens(
    input,
    sectors,
    "The screen is constrained to sectors with public conviction-versus-price divergence.",
  );
  warnings.push(...screenResults.warnings);
  capabilityViewsUpdated.push(...screenResults.capabilityViewsUpdated);
  cacheStats.hits += screenResults.capabilityViewCacheStats.hits;
  cacheStats.misses += screenResults.capabilityViewCacheStats.misses;
  cacheStats.writes += screenResults.capabilityViewCacheStats.writes;
  const pipelineLabels = hasOptionalPipelineStep(workflow)
    ? await runOptionalCandidatePipelineLabels(input, screenResults.view.rows)
    : { labels: {}, warnings: [] };
  warnings.push(...pipelineLabels.warnings);
  return sectorScreenResult({
    workflowName: workflow.workflowName,
    pgCapabilityViews: {
      sectorDivergenceView: divergenceView,
      featureScreenView: screenResults.view,
    },
    sectors,
    screenView: screenResults.view,
    pipelineLabels: pipelineLabels.labels,
    warnings,
    capabilityViewsUpdated,
    capabilityViewCacheStats: cacheStats,
  });
}

async function executeFeatureScreenPlusBacktest(
  input: ResearchPlanExecutionInput,
  workflow: ResearchWorkflowMatch,
): Promise<ResearchPlanExecutionResult> {
  const warnings: string[] = [];
  const featureStep = workflow.steps.find((step) => step.capability === "feature_screen");
  const criteria = normalizeFeatureCriteriaParam(
    arrayParam(featureStep?.params.criteria),
  );
  const capabilityViewsUpdated: CachedCapabilityView[] = [];
  const cacheStats = { hits: 0, misses: 0, writes: 0 };
  const screenResult = await runPlannerPgCapability(input, {
    ...capabilityClassification(input.classification, "feature_screen"),
    featureCriteria: criteria,
  });
  warnings.push(...screenResult.warnings);
  capabilityViewsUpdated.push(...screenResult.viewsUpdated);
  cacheStats.hits += screenResult.cacheStats.hits;
  cacheStats.misses += screenResult.cacheStats.misses;
  cacheStats.writes += screenResult.cacheStats.writes;
  const featureScreenView = screenResult.views.featureScreenView;
  const backtestCriteria = featureCriteriaToBacktestCriteria(
    featureScreenView?.screenCriteria?.length ? featureScreenView.screenCriteria : criteria,
  );
  const backtestStep = workflow.steps.find(
    (step) => step.capability === "factor_conditioned_backtest",
  );
  const horizon = supportedHorizon(stringParam(backtestStep?.params.horizon)) ?? "60-day";
  const backtestResult = await runPlannerPgCapability(input, {
    ...capabilityClassification(input.classification, "factor_conditioned_backtest"),
    factorBacktest: { criteria: backtestCriteria, horizon },
  });
  warnings.push(...backtestResult.warnings);
  capabilityViewsUpdated.push(...backtestResult.viewsUpdated);
  cacheStats.hits += backtestResult.cacheStats.hits;
  cacheStats.misses += backtestResult.cacheStats.misses;
  cacheStats.writes += backtestResult.cacheStats.writes;
  return {
    handled: true,
    pgCapabilityViews: {
      ...(featureScreenView ? { featureScreenView } : {}),
      ...backtestResult.views,
    },
    capabilityViewsUpdated,
    capabilityViewCacheStats: cacheStats,
    workflowExecutionResult: buildWorkflowExecutionResult({
      workflowName: workflow.workflowName,
      publicViews: {
        pgCapabilityViews: {
          ...(featureScreenView ? { featureScreenView } : {}),
          ...backtestResult.views,
        },
      },
      warnings: unique([
        ...warnings,
        "The factor backtest is aggregate historical context for the screen criteria, not stock-specific proof.",
      ]),
    }),
    compoundResearchContext: {
      workflowName: workflow.workflowName,
      planType: "approved_multi_step_workflow",
      featureScreenCriteria: criteria,
      candidatePipelineLabels: {},
      warnings: unique([
        ...warnings,
        "The factor backtest is aggregate historical context for the screen criteria, not stock-specific proof.",
      ]),
    },
    warnings: unique(warnings),
  };
}

async function executeStockDeepDiveStack(
  input: ResearchPlanExecutionInput,
  workflow: ResearchWorkflowMatch,
): Promise<ResearchPlanExecutionResult> {
  const warnings: string[] = [];
  const stockStep = workflow.steps.find((step) => step.capability === "stock_research_object");
  const symbol = stringParam(stockStep?.params.symbol) ?? input.classification.symbols[0];
  if (!symbol) return { handled: false, warnings: ["No stock symbol was available for the deep-dive workflow."] };
  const stockClassification = {
    ...capabilityClassification(input.classification, "stock"),
    symbols: [symbol.toUpperCase()],
  };
  const stockResearchObjects = await runPlannerResearchObjects(input, stockClassification);
  warnings.push(...stockResearchObjects.warnings);
  // Pull sibling sector AND sibling industry research objects so the agent
  // can do stock-vs-sector AND stock-vs-industry comparisons directly from
  // the research-object set. Both are inferred from the stock RO when the
  // user didn't name them explicitly.
  const sectorAnchor = inferSectorFromResearchObjects(stockResearchObjects.objects);
  const industryAnchor = inferIndustryFromResearchObjects(stockResearchObjects.objects);
  const allObjects = [...stockResearchObjects.objects];
  if (sectorAnchor) {
    const sectorResearchObjects = await runPlannerResearchObjects(input, {
      ...capabilityClassification(input.classification, "sector"),
      sectors: [sectorAnchor],
    });
    warnings.push(...sectorResearchObjects.warnings);
    allObjects.push(...sectorResearchObjects.objects);
  }
  if (industryAnchor) {
    const industryResearchObjects = await runPlannerResearchObjects(input, {
      ...capabilityClassification(input.classification, "industry"),
      industries: [industryAnchor],
    });
    warnings.push(...industryResearchObjects.warnings);
    allObjects.push(...industryResearchObjects.objects);
  }
  const pipelineLabels = hasOptionalPipelineStep(workflow)
    ? await runOptionalSymbolsPipelineLabels(input, [symbol])
    : { labels: {}, warnings: [] };
  warnings.push(...pipelineLabels.warnings);
  return {
    handled: true,
    researchObjects: allObjects,
    researchObjectsUpdated: [],
    researchObjectCacheStats: stockResearchObjects.stats,
    pgCapabilityViews: {},
    compoundResearchContext: {
      workflowName: workflow.workflowName,
      planType: "approved_multi_step_workflow",
      selectedSymbol: symbol.toUpperCase(),
      ...(sectorAnchor ? { selectedSectors: [sectorAnchor] } : {}),
      candidatePipelineLabels: pipelineLabels.labels,
      warnings: unique(warnings),
    },
    workflowExecutionResult: buildWorkflowExecutionResult({
      workflowName: workflow.workflowName,
      publicViews: {
        researchObjectViews: allObjects
          .map((item) => item.view)
          .filter((view): view is NonNullable<typeof view> => Boolean(view)),
        pgCapabilityViews: {},
      },
      pipelineLabels: pipelineLabels.labels,
      warnings: unique(warnings),
    }),
    warnings: unique(warnings),
  };
}

/**
 * Pull the first stock RO's `publicSummary.sector` so the caller can load
 * the matching sibling sector RO. Used when the user asks a stock question
 * that needs sector context — either via the stock_deep_dive_stack workflow
 * or via the standard loader's auto-sibling pass — but didn't name the
 * sector explicitly. Exported for reuse across the planner and the
 * standard `loadResearchObjects` node.
 */
export function inferSectorFromResearchObjects(
  objects: CachedResearchObject[],
): string | undefined {
  for (const object of objects) {
    if (object.objectType !== "stock") continue;
    const summary = object.publicSummary as { sector?: unknown } | undefined;
    if (typeof summary?.sector === "string" && summary.sector.trim().length) {
      return summary.sector.trim();
    }
  }
  return undefined;
}

/**
 * Mirror of `inferSectorFromResearchObjects` for industry. Reads
 * `publicSummary.industry` (which `buildStockSummary` populates from the
 * core SQL's `meta.industry`). Lets the caller load the sibling industry
 * RO whenever the user asks a "compare to its industry / peers" question
 * without naming the industry explicitly.
 */
export function inferIndustryFromResearchObjects(
  objects: CachedResearchObject[],
): string | undefined {
  for (const object of objects) {
    if (object.objectType !== "stock") continue;
    const summary = object.publicSummary as { industry?: unknown } | undefined;
    if (typeof summary?.industry === "string" && summary.industry.trim().length) {
      return summary.industry.trim();
    }
  }
  return undefined;
}

async function executeIdeaToCompareAndRisk(
  input: ResearchPlanExecutionInput,
  workflow: ResearchWorkflowMatch,
): Promise<ResearchPlanExecutionResult> {
  const warnings: string[] = [];
  const capabilityViewsUpdated: CachedCapabilityView[] = [];
  const cacheStats = { hits: 0, misses: 0, writes: 0 };
  const ideaResult = await runPlannerPgCapability(input, capabilityClassification(
    input.classification,
    "stock_idea_discovery",
  ));
  warnings.push(...ideaResult.warnings);
  capabilityViewsUpdated.push(...ideaResult.viewsUpdated);
  cacheStats.hits += ideaResult.cacheStats.hits;
  cacheStats.misses += ideaResult.cacheStats.misses;
  cacheStats.writes += ideaResult.cacheStats.writes;
  const ideaView = ideaResult.views.stockIdeaView;
  const symbol = topStockIdeaSymbol(ideaView);
  if (!symbol) {
    warnings.push("No current stock idea candidate was available for comparison and risk checks.");
    return {
      handled: true,
      pgCapabilityViews: ideaResult.views,
      capabilityViewsUpdated,
      capabilityViewCacheStats: cacheStats,
      workflowExecutionResult: buildWorkflowExecutionResult({
        workflowName: workflow.workflowName,
        publicViews: {
          pgCapabilityViews: ideaResult.views,
        },
        warnings: unique(warnings),
      }),
      compoundResearchContext: {
        workflowName: workflow.workflowName,
        planType: "approved_multi_step_workflow",
        candidatePipelineLabels: {},
        warnings: unique(warnings),
      },
      warnings: unique(warnings),
    };
  }
  const stockClassification = {
    ...capabilityClassification(input.classification, "stock"),
    symbols: [symbol],
  };
  const stockResearchObjects = await runPlannerResearchObjects(input, stockClassification);
  warnings.push(...stockResearchObjects.warnings);
  const sectorAnchor = inferSectorFromResearchObjects(stockResearchObjects.objects);
  const allObjects = [...stockResearchObjects.objects];
  if (sectorAnchor) {
    const sectorResearchObjects = await runPlannerResearchObjects(input, {
      ...capabilityClassification(input.classification, "sector"),
      sectors: [sectorAnchor],
    });
    warnings.push(...sectorResearchObjects.warnings);
    allObjects.push(...sectorResearchObjects.objects);
  }
  const pipelineLabels = hasOptionalPipelineStep(workflow)
    ? await runOptionalSymbolsPipelineLabels(input, [symbol])
    : { labels: {}, warnings: [] };
  warnings.push(...pipelineLabels.warnings);
  return {
    handled: true,
    researchObjects: allObjects,
    researchObjectsUpdated: [],
    researchObjectCacheStats: stockResearchObjects.stats,
    pgCapabilityViews: {
      stockIdeaView: ideaView,
    },
    capabilityViewsUpdated,
    capabilityViewCacheStats: cacheStats,
    workflowExecutionResult: buildWorkflowExecutionResult({
      workflowName: workflow.workflowName,
      publicViews: {
        researchObjectViews: allObjects
          .map((item) => item.view)
          .filter((view): view is NonNullable<typeof view> => Boolean(view)),
        pgCapabilityViews: {
          stockIdeaView: ideaView,
        },
      },
      pipelineLabels: pipelineLabels.labels,
      warnings: unique([
        ...warnings,
        "The stock idea is a research candidate, not an action instruction.",
      ]),
    }),
    compoundResearchContext: {
      workflowName: workflow.workflowName,
      planType: "approved_multi_step_workflow",
      selectedSymbol: symbol,
      ...(sectorAnchor ? { selectedSectors: [sectorAnchor] } : {}),
      candidatePipelineLabels: pipelineLabels.labels,
      warnings: unique([
        ...warnings,
        "The stock idea is a research candidate, not an action instruction.",
      ]),
    },
    warnings: unique(warnings),
  };
}

async function runPlannerPgCapability(
  input: ResearchPlanExecutionInput,
  classification: Classification,
): Promise<
  PgCapabilityRunResult & {
    viewsUpdated: CachedCapabilityView[];
    cacheStats: { hits: number; misses: number; writes: number };
  }
> {
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
  return {
    views: result.views,
    warnings: result.warnings,
    viewsUpdated: result.viewsUpdated ?? [],
    cacheStats: result.cacheStats ?? { hits: 0, misses: 0, writes: 0 },
  };
}

async function runPlannerResearchObjects(
  input: ResearchPlanExecutionInput,
  classification: Classification,
): Promise<ResearchObjectBuildResult> {
  return (input.researchObjectBuilder ?? buildResearchObjects)({
    classification,
    snapshots: input.snapshots,
    toolOutputs: input.toolOutputs,
    priorResearchObjects: input.priorResearchObjects ?? [],
  });
}

function baseClassification(classification: Classification): Classification {
  return {
    intent: classification.intent,
    symbols: [],
    sectors: [],
    industries: [],
    regimeRequested: false,
    isFollowUp: false,
    requiresTools: classification.requiresTools ?? [],
    confidence: classification.confidence,
    warnings: [],
  };
}

function capabilityClassification(
  classification: Classification,
  intent: Classification["intent"],
): Classification {
  return {
    ...baseClassification(classification),
    intent,
    focus: undefined,
    symbols: [],
    sectors: [],
    featureCriteria: undefined,
    factorBacktest: undefined,
    regimeRequested: intent === "regime",
  };
}

function sectorScreenResult(input: {
  workflowName: ResearchWorkflowName;
  pgCapabilityViews: PgCapabilityViews;
  sectors: string[];
  screenView: FeatureScreenView;
  pipelineLabels: Record<string, string>;
  warnings: string[];
  capabilityViewsUpdated?: CachedCapabilityView[];
  capabilityViewCacheStats?: { hits: number; misses: number; writes: number };
}): ResearchPlanExecutionResult {
  return {
    handled: true,
    pgCapabilityViews: input.pgCapabilityViews,
    capabilityViewsUpdated: input.capabilityViewsUpdated ?? [],
    capabilityViewCacheStats:
      input.capabilityViewCacheStats ?? { hits: 0, misses: 0, writes: 0 },
    workflowExecutionResult: buildWorkflowExecutionResult({
      workflowName: input.workflowName,
      publicViews: { pgCapabilityViews: input.pgCapabilityViews },
      pipelineLabels: input.pipelineLabels,
      warnings: unique(input.warnings),
    }),
    compoundResearchContext: {
      workflowName: input.workflowName,
      planType:
        input.workflowName === "regime_to_stock_screen"
          ? "regime_sector_to_stock_screen"
          : "approved_multi_step_workflow",
      leadingSectors:
        input.workflowName === "regime_to_stock_screen"
          ? input.sectors
          : undefined,
      selectedSectors: input.sectors,
      featureScreenCriteria: input.screenView.screenCriteria,
      candidatePipelineLabels: input.pipelineLabels,
      warnings: unique(input.warnings),
    },
    warnings: unique(input.warnings),
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

function extractImprovedSectors(
  view: PgCapabilityViews["sectorDeltaView"],
): string[] {
  if (!view) return [];
  return unique(
    [...view.rows]
      .filter((row) => row.direction === "improved" && typeof row.sector === "string")
      .sort((left, right) => numberSortValue(left.rank) - numberSortValue(right.rank))
      .map((row) => row.sector),
  ).slice(0, MAX_SECTOR_CONSTRAINTS);
}

function extractDivergenceSectors(
  view: PgCapabilityViews["sectorDivergenceView"],
): string[] {
  if (!view) return [];
  return unique(
    [...view.rows]
      .filter((row) => typeof row.sector === "string")
      .sort((left, right) => numberSortValue(left.rank) - numberSortValue(right.rank))
      .map((row) => row.sector),
  ).slice(0, MAX_SECTOR_CONSTRAINTS);
}

async function runSectorFeatureScreens(
  input: ResearchPlanExecutionInput,
  sectors: string[],
  constraintWarning: string,
): Promise<{
  view: FeatureScreenView;
  warnings: string[];
  capabilityViewsUpdated: CachedCapabilityView[];
  capabilityViewCacheStats: { hits: number; misses: number; writes: number };
}> {
  const warnings: string[] = [];
  const views: FeatureScreenView[] = [];
  const capabilityViewsUpdated: CachedCapabilityView[] = [];
  const cacheStats = { hits: 0, misses: 0, writes: 0 };
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
        focus: undefined,
      });
      warnings.push(...result.warnings);
      capabilityViewsUpdated.push(...result.viewsUpdated);
      cacheStats.hits += result.cacheStats.hits;
      cacheStats.misses += result.cacheStats.misses;
      cacheStats.writes += result.cacheStats.writes;
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
  return {
    view: mergeFeatureScreenViews(sectors, views, constraintWarning),
    warnings: unique(warnings),
    capabilityViewsUpdated,
    capabilityViewCacheStats: cacheStats,
  };
}

function mergeFeatureScreenViews(
  sectors: string[],
  views: FeatureScreenView[],
  constraintWarning: string,
): FeatureScreenView {
  const criteria = sectors
    .slice(0, MAX_SECTOR_CONSTRAINTS)
    .map((sector): FeatureScreenCriterion => ({ factor: "sector", bucket: sector }));
  const warnings = unique([
    "These are screen results for research review, not action instructions.",
    constraintWarning,
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
    viewSchemaVersion: 2,
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
    researchObjectKeys: Array.from(
      new Set(rows.map((row) => row.researchObjectKey).filter(Boolean)),
    ),
    freshness,
    warnings: rows.length
      ? warnings
      : unique([...warnings, "No current stock candidates matched the sector-constrained screen."]),
  };
}

function emptySectorScreenView(
  sectors: string[],
  warning: string,
): FeatureScreenView {
  const criteria = sectors
    .slice(0, MAX_SECTOR_CONSTRAINTS)
    .map((sector): FeatureScreenCriterion => ({ factor: "sector", bucket: sector }));
  return {
    viewSchemaVersion: 2,
    state: sectors.length ? "complete" : "unavailable",
    source: "pg_current_features",
    screenCriteria: criteria,
    rows: [],
    researchObjectKeys: [],
    freshness: { state: "unknown" },
    warnings: [warning],
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
  const symbols = unique(
    rows
      .map((row) => row.symbol)
      .filter(stringGuard)
      .map((symbol) => symbol.toUpperCase()),
  ).slice(0, MAX_PIPELINE_SYMBOLS);

  return runOptionalSymbolsPipelineLabels(input, symbols);
}

async function runOptionalSymbolsPipelineLabels(
  input: ResearchPlanExecutionInput,
  symbolsInput: string[],
): Promise<{ labels: Record<string, string>; warnings: string[] }> {
  const warnings: string[] = [];
  const labels: Record<string, string> = {};
  const symbols = unique(
    symbolsInput
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

function hasOptionalPipelineStep(workflow: ResearchWorkflowMatch): boolean {
  return workflow.steps.some(
    (step) => step.capability === "validated_edge_evidence" && step.optional === true,
  );
}

function topStockIdeaSymbol(
  view: PgCapabilityViews["stockIdeaView"],
): string | undefined {
  return view?.rows
    .slice()
    .sort((left, right) => numberSortValue(left.rank) - numberSortValue(right.rank))
    .map((row) => row.symbol)
    .filter(stringGuard)[0]
    ?.toUpperCase();
}

function normalizeFeatureCriteriaParam(values: unknown[]): FeatureScreenCriterion[] {
  return values
    .filter(isRecord)
    .map((item) => {
      const factor = item.factor;
      const bucket = item.bucket;
      if (
        ![
          "valuation",
          "quality",
          "momentum",
          "growth",
          "leverage",
          "sector",
          "risk",
        ].includes(String(factor)) ||
        typeof bucket !== "string"
      ) {
        return undefined;
      }
      return { factor: factor as FeatureScreenCriterion["factor"], bucket };
    })
    .filter((item): item is FeatureScreenCriterion => Boolean(item))
    .slice(0, 7);
}

function featureCriteriaToBacktestCriteria(
  criteria: FeatureScreenCriterion[],
): FactorBacktestCriterion[] {
  return criteria
    .filter(
      (criterion): criterion is FactorBacktestCriterion =>
        ["valuation", "quality", "momentum", "growth", "leverage", "sector"].includes(
          criterion.factor,
        ),
    )
    .map((criterion) => ({ factor: criterion.factor, bucket: criterion.bucket }))
    .slice(0, 6);
}

function supportedHorizon(
  value: string | undefined,
): FactorBacktestHorizon | undefined {
  return ["20-day", "40-day", "60-day", "120-day", "252-day"].includes(value ?? "")
    ? (value as FactorBacktestHorizon)
    : undefined;
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

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function stringGuard(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
