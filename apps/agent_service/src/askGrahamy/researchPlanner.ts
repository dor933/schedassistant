import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { logger } from "../logger";
import { anthropicBaseConfig } from "../chat/anthropic/anthropicContextManagement";
import { runAnthropicOneShot } from "../chat/anthropic/anthropicOneShot";
import { resolveOrgVendorByOrg } from "../utils/resolveOrgVendor.service";
import type {
  CachedResearchObject,
  Classification,
  FactorBacktestCriterion,
  FactorBacktestHorizon,
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

export type ResearchWorkflowName =
  | "regime_to_stock_screen"
  | "sector_delta_to_stock_screen"
  | "sector_divergence_to_stock_screen"
  | "feature_screen_plus_backtest"
  | "stock_deep_dive_stack"
  | "idea_to_compare_and_risk";

export type ResearchWorkflowSpec = {
  workflowName: ResearchWorkflowName;
  requiredSteps: PlannedCapability[];
  optionalSteps: PlannedCapability[];
  allowedStepOrder: PlannedCapability[];
  allowedChainingPaths: string[];
  maxSteps: number;
  maxSectors: number;
  maxCandidates: number;
  maxPipelineSymbols: number;
  fallbackBehavior: string;
  publicSafeOutput: string;
};

export type ResearchWorkflowMatch = {
  workflowName: ResearchWorkflowName;
  spec: ResearchWorkflowSpec;
  steps: ResearchPlanStep[];
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
  pipelineOverlayViews?: PipelineOverlayViews;
  workflowExecutionResult?: WorkflowExecutionResult;
  compoundResearchContext?: CompoundResearchContext;
  warnings: string[];
};

export type ResearchPlanExecutor = (
  input: ResearchPlanExecutionInput,
) => Promise<ResearchPlanExecutionResult>;

const ASK_GRAHAMY_ORG_ID =
  process.env.ASK_GRAHAMY_ORG_ID ?? "acf0cbab-3aed-42cf-872d-63cba24e61c3";

const PLANNER_MODEL =
  process.env.ASK_GRAHAMY_RESEARCH_PLANNER_MODEL ?? "claude-sonnet-4-6";

const MAX_STEPS = 5;
const MAX_SECTOR_CONSTRAINTS = 3;
const MAX_CANDIDATES = 10;
const MAX_PIPELINE_SYMBOLS = 3;
const FORBIDDEN_TOKEN_PATTERN =
  /\b(raw\s*sql|sql|raw\s*rows?|table(?:s)?|edge_id|hypothesis_id|gates?|thresholds?|feature_rules?|sqlite|\.db|grahamy_discovery|pipeline_state|sentinel\s+rows?|coroner|stop[-\s]?loss|sizing|buy|sell)\b/i;

const planStepSchema = z.object({
  id: z.string().trim().min(1).max(60),
  capability: z.enum(PLANNABLE_CAPABILITIES),
  purpose: z.string().trim().min(1).max(300),
  params: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.record(z.string(), z.unknown()).default({}),
  ),
  dependsOn: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.array(z.string().trim().min(1).max(60)).max(4).optional(),
  ),
  paramsFromPreviousSteps: z.preprocess(
    (value) => (value === null ? undefined : value),
    z
      .record(
        z.string(),
        z.object({
          stepId: z.string().trim().min(1).max(60),
          sourcePath: z.string().trim().min(1).max(160),
          transform: z.string().trim().min(1).max(80),
        }),
      )
      .optional(),
  ),
  optional: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.boolean().optional(),
  ),
});

export const researchPlanSchema = z.object({
  planType: z.enum(["single_step", "multi_step"]),
  steps: z.array(planStepSchema).min(1).max(MAX_STEPS),
  finalAnswerGoal: z.string().trim().min(1).max(160),
  expectedViews: z.array(z.string().trim().min(1).max(80)).max(8),
  safetyNotes: z.array(z.string().trim().min(1).max(180)).max(8),
});

const RESEARCH_PLAN_JSON_SCHEMA = zodToJsonSchema(
  researchPlanSchema as never,
  { target: "openAi", $refStrategy: "none" },
);

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
      "sectorDeltaView.rows[direction=improved].sector",
      "sectorDivergenceView.rows.sector",
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
  risk_path: {
    name: "risk_path",
    answers: "Risk-focused answer from public pathRisk fields.",
    requiredParams: ["anchor"],
    optionalParams: [],
    outputView: "researchObjectViews.pathRisk",
    allowedChainingInputs: [
      "stock_research_object anchor",
      "stockIdeaView.rows[0].symbol",
    ],
    whenNotToUse: ["Never substitute forward returns for drawdown risk."],
  },
  validated_edge_evidence: {
    name: "validated_edge_evidence",
    answers: "Public Pipeline validation overlay for explicit anchors or top candidates.",
    requiredParams: ["anchor or symbols"],
    optionalParams: ["topN"],
    outputView: "validatedEdgeEvidenceView",
    allowedChainingInputs: [
      "featureScreenView.rows.symbol",
      "stockIdeaView.rows[0].symbol",
      "stock_research_object anchor",
    ],
    maxRows: MAX_PIPELINE_SYMBOLS,
    whenNotToUse: ["Must be optional for PG candidate screens."],
  },
};

export const RESEARCH_WORKFLOW_REGISTRY: ResearchWorkflowSpec[] = [
  {
    workflowName: "regime_to_stock_screen",
    requiredSteps: ["market_regime_historical_playbook", "feature_screen"],
    optionalSteps: ["validated_edge_evidence"],
    allowedStepOrder: [
      "market_regime_historical_playbook",
      "feature_screen",
      "validated_edge_evidence",
    ],
    allowedChainingPaths: [
      "regimeHistoricalPlaybookView.rows[role=leader].sector",
      "featureScreenView.rows.symbol",
    ],
    maxSteps: 3,
    maxSectors: MAX_SECTOR_CONSTRAINTS,
    maxCandidates: MAX_CANDIDATES,
    maxPipelineSymbols: MAX_PIPELINE_SYMBOLS,
    fallbackBehavior: "Return regime sector context if stock screening is unavailable.",
    publicSafeOutput:
      "regimeHistoricalPlaybookView plus sector-constrained featureScreenView.",
  },
  {
    workflowName: "sector_delta_to_stock_screen",
    requiredSteps: ["week_over_week_sector_delta", "feature_screen"],
    optionalSteps: ["validated_edge_evidence"],
    allowedStepOrder: [
      "week_over_week_sector_delta",
      "feature_screen",
      "validated_edge_evidence",
    ],
    allowedChainingPaths: [
      "sectorDeltaView.rows[direction=improved].sector",
      "featureScreenView.rows.symbol",
    ],
    maxSteps: 3,
    maxSectors: MAX_SECTOR_CONSTRAINTS,
    maxCandidates: MAX_CANDIDATES,
    maxPipelineSymbols: MAX_PIPELINE_SYMBOLS,
    fallbackBehavior: "Return weekly sector delta context if stock screening is unavailable.",
    publicSafeOutput: "sectorDeltaView plus sector-constrained featureScreenView.",
  },
  {
    workflowName: "sector_divergence_to_stock_screen",
    requiredSteps: ["sector_momentum_vs_conviction_divergence", "feature_screen"],
    optionalSteps: ["validated_edge_evidence"],
    allowedStepOrder: [
      "sector_momentum_vs_conviction_divergence",
      "feature_screen",
      "validated_edge_evidence",
    ],
    allowedChainingPaths: [
      "sectorDivergenceView.rows.sector",
      "featureScreenView.rows.symbol",
    ],
    maxSteps: 3,
    maxSectors: MAX_SECTOR_CONSTRAINTS,
    maxCandidates: MAX_CANDIDATES,
    maxPipelineSymbols: MAX_PIPELINE_SYMBOLS,
    fallbackBehavior: "Return no candidates if no true divergence sectors are present.",
    publicSafeOutput: "sectorDivergenceView plus sector-constrained featureScreenView.",
  },
  {
    workflowName: "feature_screen_plus_backtest",
    requiredSteps: ["feature_screen", "factor_conditioned_backtest"],
    optionalSteps: [],
    allowedStepOrder: ["feature_screen", "factor_conditioned_backtest"],
    allowedChainingPaths: ["featureScreenView.screenCriteria"],
    maxSteps: 2,
    maxSectors: MAX_SECTOR_CONSTRAINTS,
    maxCandidates: MAX_CANDIDATES,
    maxPipelineSymbols: 0,
    fallbackBehavior: "Return screen candidates even if the aggregate factor backtest is unavailable.",
    publicSafeOutput: "featureScreenView plus aggregate factorBacktestView.",
  },
  {
    workflowName: "stock_deep_dive_stack",
    requiredSteps: ["stock_research_object", "risk_path"],
    optionalSteps: ["sector_research_object", "validated_edge_evidence"],
    allowedStepOrder: [
      "stock_research_object",
      "sector_research_object",
      "risk_path",
      "validated_edge_evidence",
    ],
    allowedChainingPaths: [
      "stock_research_object anchor",
      "featureScreenView.rows.symbol",
    ],
    maxSteps: 4,
    maxSectors: 1,
    maxCandidates: 1,
    maxPipelineSymbols: 1,
    fallbackBehavior: "Return the stock Research Object if sibling sector or Pipeline evidence is unavailable.",
    publicSafeOutput: "stock Research Object, optional sector Research Object, optional validatedEdgeEvidenceView.",
  },
  {
    workflowName: "idea_to_compare_and_risk",
    requiredSteps: ["stock_idea_discovery", "risk_path"],
    optionalSteps: ["sector_research_object", "validated_edge_evidence"],
    allowedStepOrder: [
      "stock_idea_discovery",
      "sector_research_object",
      "risk_path",
      "validated_edge_evidence",
    ],
    allowedChainingPaths: [
      "stockIdeaView.rows[0].symbol",
      "stock_research_object anchor",
    ],
    maxSteps: 4,
    maxSectors: 1,
    maxCandidates: 1,
    maxPipelineSymbols: 1,
    fallbackBehavior: "Return the stock idea candidate if sibling sector or risk evidence is unavailable.",
    publicSafeOutput: "stockIdeaView, top candidate Research Object, optional sector Research Object, optional validatedEdgeEvidenceView.",
  },
];

export function buildFallbackResearchPlan(message: string): ResearchPlan | null {
  const workflowName = detectResearchWorkflowIntent(message);
  if (!workflowName) return null;
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

function detectResearchWorkflowIntent(message: string): ResearchWorkflowName | null {
  const text = message.toLowerCase();
  const regimeToStockScreen =
    (/current\s+(regime|market condition|market backdrop)|what should i look at based on.*regime/.test(text) ||
      /מצב\s+השוק|משטר\s+השוק/.test(text)) &&
    (/historically strong sectors|what works in this regime|sectors.*strong|sectors.*work/.test(text) ||
      /סקטור.*חזק|סקטורים.*חזקים|מה.*עובד/.test(text)) &&
    (/\b(stocks|names|candidates|look at now)\b/.test(text) ||
      /מניות|מועמדים|משהו\s+נוכחי/.test(text));

  const sectorDeltaToStockScreen =
    (/sectors? improved|improved this week|strengthened this week/.test(text) ||
      /סקטורים?\s+התחזק|התחזקו\s+השבוע/.test(text)) &&
    (/\b(stocks|names|candidates|interesting)\b/.test(text) ||
      /מניות|מועמדים|מעניינות/.test(text));

  const divergenceToStockScreen =
    (/conviction.*weak price|evidence.*price|divergence/.test(text) ||
      /פער\s+בין\s+ראיות\s+למחיר|פער.*מחיר|ראיות.*מחיר/.test(text)) &&
    (/\b(stocks|names|candidates|interesting)\b/.test(text) ||
      /מניות|מועמדים|מעניינות/.test(text));

  const featureScreenPlusBacktest =
    (/\b(find|show|screen)\b.*\b(cheap|attractive|quality)\b/.test(text) ||
      /מצא.*מניות|מניות.*זולות|איכותיות/.test(text)) &&
    (/worked historically|historical|backtest|worked in the past/.test(text) ||
      /עבד\s+בעבר|היסטורית|שילוב.*עבר/.test(text));

  const stockDeepDiveStack =
    (/\b(what do you think|deep dive|full analysis|analysis)\b/.test(text) ||
      /ניתוח\s+מלא|מה\s+דעתך|כולל/.test(text)) &&
    (/\b(risk|downside)\b/.test(text) || /סיכון|ירידה/.test(text)) &&
    (/\b(sector comparison|compare .* sector|vs .* sector|sector)\b/.test(text) ||
      /השוואה\s+לסקטור|מול\s+הסקטור|לסקטור/.test(text));

  const ideaToCompareAndRisk =
    (/\b(interesting stock|stock idea|idea for a stock|give me an idea)\b/.test(text) ||
      /רעיון\s+למניה|מניה\s+מעניינת|תן\s+לי\s+רעיון/.test(text)) &&
    (/\b(compare|sector)\b/.test(text) || /סקטור|השוואה|מול/.test(text)) &&
    (/\b(risk|downside)\b/.test(text) || /סיכון|ירידה/.test(text));

  if (regimeToStockScreen) return "regime_to_stock_screen";
  if (sectorDeltaToStockScreen) return "sector_delta_to_stock_screen";
  if (divergenceToStockScreen) return "sector_divergence_to_stock_screen";
  if (featureScreenPlusBacktest) return "feature_screen_plus_backtest";
  if (stockDeepDiveStack) return "stock_deep_dive_stack";
  if (ideaToCompareAndRisk) return "idea_to_compare_and_risk";
  return null;
}

function extractSymbol(message: string): string | undefined {
  const match = message.match(/\b[A-Z]{1,5}\b/);
  return match?.[0]?.toUpperCase();
}

const PLANNER_SYSTEM_PROMPT = `You are Ask Grahamy's internal research planner.
Return a structured ResearchPlan only. Do not answer the user.

You may plan only these public capabilities:
${Object.values(PLANNING_CAPABILITY_REGISTRY)
  .map(
    (spec) =>
      `- ${spec.name}: ${spec.answers}; output=${spec.outputView}; bounds=${spec.maxRows ?? "bounded by executor"}`,
  )
  .join("\n")}

Approved multi-step workflows:
${RESEARCH_WORKFLOW_REGISTRY.map(
  (workflow) =>
    `- ${workflow.workflowName}: ${workflow.allowedStepOrder.join(" -> ")}; output=${workflow.publicSafeOutput}`,
).join("\n")}

Planning rules:
- Use multi_step only when the user asks for compound research requiring more than one public view.
- The plan must match one approved workflow exactly. Do not invent arbitrary tool order.
- Never request SQL, raw rows, table names, IDs, gates, thresholds, feature rules, SQLite, or Pipeline internals.
- feature_screen must have explicit public criteria or sectorConstraints from a prior public step.
- validated_edge_evidence is optional for stock candidate screens and must not block PG candidates.
- For current-regime sector-to-stock questions, prefer:
  market_regime_historical_playbook -> feature_screen constrained by leader sectors -> optional validated_edge_evidence for top candidates.
- For weekly sector improvement-to-stock questions, use:
  week_over_week_sector_delta -> feature_screen constrained by improved sectors -> optional validated_edge_evidence.
- For conviction/price divergence-to-stock questions, use:
  sector_momentum_vs_conviction_divergence -> feature_screen constrained by divergence sectors -> optional validated_edge_evidence.
- For screen plus historical setup questions, use:
  feature_screen -> factor_conditioned_backtest with the same public criteria.
- For explicit stock deep dives asking for risk and sector comparison, use:
  stock_research_object -> optional sector_research_object -> risk_path -> optional validated_edge_evidence.
  The agent compares the stock and sector side-by-side directly from the research objects.
- For interesting stock idea plus sector/risk checks, use:
  stock_idea_discovery -> optional sector_research_object for the top public candidate -> risk_path -> optional validated_edge_evidence.
- Use sourcePath values only from public views.
- Allowed chaining examples:
  regimeHistoricalPlaybookView.rows[role=leader].sector -> feature_screen sectorConstraints with transform top_3_unique_sectors.
  sectorDeltaView.rows[direction=improved].sector -> feature_screen sectorConstraints with transform top_3_improved_sectors.
  sectorDivergenceView.rows.sector -> feature_screen sectorConstraints with transform top_3_divergence_sectors.
  featureScreenView.rows.symbol -> optional validated_edge_evidence symbols with transform top_3_symbols.
  featureScreenView.screenCriteria -> factor_conditioned_backtest criteria with transform public_criteria_only.
  stockIdeaView.rows[0].symbol -> sector_research_object/risk_path/validated_edge_evidence with transform top_candidate_symbol.
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

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const match = /^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function parsePlannerJson(raw: string): unknown {
  const stripped = stripCodeFences(raw);
  try {
    return JSON.parse(stripped);
  } catch (firstErr) {
    const extracted = extractFirstJsonObject(stripped);
    if (extracted) {
      try {
        return JSON.parse(extracted);
      } catch {
        /* fall through to original parse error */
      }
    }
    throw firstErr;
  }
}

export function shouldRunResearchPlanner(
  message: string,
  classification: Classification,
): boolean {
  const workflow = detectResearchWorkflowIntent(message);
  if (!workflow) return false;
  if (classification.focus === "validated_evidence") {
    return false;
  }
  if (workflow === "stock_deep_dive_stack") {
    return classification.symbols.length === 1 || Boolean(extractSymbol(message));
  }
  return true;
}

export async function proposeResearchPlan(message: string): Promise<ResearchPlan> {
  const vendor = await resolveOrgVendorByOrg(PLANNER_MODEL, ASK_GRAHAMY_ORG_ID);
  if (!vendor || !vendor.apiKey) {
    throw new Error("Ask Grahamy research planner model is unavailable.");
  }
  if (vendor.vendorSlug === "anthropic" && vendor.keyType === "oauth_token") {
    const text = await runAnthropicOneShot({
      credential: vendor.apiKey,
      keyType: vendor.keyType,
      model: PLANNER_MODEL,
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      userPrompt: `User question:\n${message}`,
      jsonSchemaHint: RESEARCH_PLAN_JSON_SCHEMA,
    });
    return parseResearchPlan(parsePlannerJson(text));
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
    },
    "plan",
    errors,
  );

  return errors.length
    ? { ok: false, errors: [...new Set(errors)], warnings: [...new Set(warnings)] }
    : { ok: true, plan: normalized, warnings: [...new Set(warnings)] };
}

export function matchApprovedResearchWorkflow(
  plan: ResearchPlan,
): ResearchWorkflowMatch | undefined {
  for (const spec of RESEARCH_WORKFLOW_REGISTRY) {
    const match = matchWorkflowSpec(plan, spec);
    if (match) return match;
  }
  return undefined;
}

export function validateResearchWorkflow(
  plan: ResearchPlan,
): PlanValidationResult & { workflow?: ResearchWorkflowMatch } {
  const base = validateResearchPlan(plan);
  if (!base.ok) return base;
  const workflow = matchApprovedResearchWorkflow(base.plan);
  if (!workflow) {
    return {
      ok: false,
      errors: [
        "Plan does not match an approved bounded research workflow pattern.",
      ],
      warnings: base.warnings,
    };
  }
  const errors = validateWorkflowSpecificRules(workflow);
  return errors.length
    ? { ok: false, errors: [...new Set(errors)], warnings: base.warnings }
    : { ok: true, plan: base.plan, warnings: base.warnings, workflow };
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
      /regimeHistoricalPlaybookView\.rows|sectorLeaderboardView\.rows|sectorDeltaView\.rows|sectorDivergenceView\.rows/.test(
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
    const criteriaFromPreviousStep = Object.values(
      step.paramsFromPreviousSteps ?? {},
    ).some((source) => source.sourcePath === "featureScreenView.screenCriteria");
    if (!criteria.length && !criteriaFromPreviousStep) {
      errors.push("factor_conditioned_backtest requires criteria.");
    }
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

function matchWorkflowSpec(
  plan: ResearchPlan,
  spec: ResearchWorkflowSpec,
): ResearchWorkflowMatch | undefined {
  if (plan.planType !== "multi_step") return undefined;
  if (plan.steps.length > spec.maxSteps) return undefined;
  const capabilities = plan.steps.map((step) => step.capability);
  const required = [...spec.requiredSteps];
  const optional = new Set(spec.optionalSteps);

  let cursor = 0;
  for (const capability of capabilities) {
    const expected = spec.allowedStepOrder[cursor];
    if (capability !== expected) return undefined;
    cursor += 1;
  }

  for (const requiredCapability of required) {
    if (!capabilities.includes(requiredCapability)) return undefined;
  }

  for (const step of plan.steps) {
    const isRequired = spec.requiredSteps.includes(step.capability);
    const isOptional = optional.has(step.capability);
    if (!isRequired && !isOptional) return undefined;
    if (isOptional && step.optional !== true) return undefined;
    if (isRequired && step.optional === true) return undefined;
  }

  return { workflowName: spec.workflowName, spec, steps: plan.steps };
}

function validateWorkflowSpecificRules(match: ResearchWorkflowMatch): string[] {
  const errors: string[] = [];
  const plan = { planType: "multi_step" as const, steps: match.steps };
  const capabilities = match.steps.map((step) => step.capability);
  if (capabilities.length > match.spec.maxSteps) {
    errors.push(`${match.workflowName} has too many steps.`);
  }

  for (const step of match.steps) {
    for (const source of Object.values(step.paramsFromPreviousSteps ?? {})) {
      if (!match.spec.allowedChainingPaths.includes(source.sourcePath)) {
        errors.push(`${match.workflowName} uses unsupported chaining path ${source.sourcePath}.`);
      }
    }
  }

  if (match.workflowName === "regime_to_stock_screen") {
    requireStepSource(
      match,
      "feature_screen",
      "regimeHistoricalPlaybookView.rows[role=leader].sector",
      "top_3_unique_sectors",
      errors,
    );
  }

  if (match.workflowName === "sector_delta_to_stock_screen") {
    requireStepSource(
      match,
      "feature_screen",
      "sectorDeltaView.rows[direction=improved].sector",
      "top_3_improved_sectors",
      errors,
    );
  }

  if (match.workflowName === "sector_divergence_to_stock_screen") {
    requireStepSource(
      match,
      "feature_screen",
      "sectorDivergenceView.rows.sector",
      "top_3_divergence_sectors",
      errors,
    );
  }

  if (match.workflowName === "feature_screen_plus_backtest") {
    const featureStep = match.steps.find((step) => step.capability === "feature_screen");
    if (!arrayParam(featureStep?.params.criteria).length) {
      errors.push("feature_screen_plus_backtest requires bounded feature_screen criteria.");
    }
    requireStepSource(
      match,
      "factor_conditioned_backtest",
      "featureScreenView.screenCriteria",
      "public_criteria_only",
      errors,
    );
  }

  if (match.workflowName === "stock_deep_dive_stack") {
    const stockStep = match.steps.find((step) => step.capability === "stock_research_object");
    const symbol = stringParam(stockStep?.params.symbol);
    if (!symbol) errors.push("stock_deep_dive_stack requires one explicit symbol.");
  }

  if (
    plan.steps.some(
      (step) =>
        step.capability === "validated_edge_evidence" &&
        step.optional !== true,
    )
  ) {
    errors.push("Pipeline validation steps must remain optional.");
  }

  return errors;
}

function requireStepSource(
  match: ResearchWorkflowMatch,
  capability: PlannedCapability,
  sourcePath: string,
  transform: string,
  errors: string[],
): void {
  const step = match.steps.find((item) => item.capability === capability);
  const hasSource = Object.values(step?.paramsFromPreviousSteps ?? {}).some(
    (source) => source.sourcePath === sourcePath && source.transform === transform,
  );
  if (!hasSource) {
    errors.push(`${match.workflowName} requires ${capability} to use ${sourcePath}.`);
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
    /^sectorDeltaView\.rows\[direction=improved\]\.sector$/,
    /^sectorDivergenceView\.rows\.sector$/,
    /^featureScreenView\.rows\.symbol$/,
    /^featureScreenView\.screenCriteria$/,
    /^stockIdeaView\.rows\[0\]\.symbol$/,
    /^stock_research_object anchor$/,
  ].some((pattern) => pattern.test(sourcePath));
}

function isAllowedTransform(transform: string): boolean {
  return [
    "top_3_unique_sectors",
    "top_3_improved_sectors",
    "top_3_divergence_sectors",
    "top_3_symbols",
    "top_candidate_symbol",
    "top_10_rows",
    "public_criteria_only",
    "implicit_sector_comparison",
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
  if (sourcePath === "sectorDeltaView.rows[direction=improved].sector") {
    const rows = rowsFromView(output, "sectorDeltaView");
    return unique(
      rows
        .filter((row) => row.direction === "improved")
        .map((row) => row.sector)
        .filter(stringGuard),
    ).slice(0, 3);
  }
  if (sourcePath === "sectorDivergenceView.rows.sector") {
    const rows = rowsFromView(output, "sectorDivergenceView");
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
  if (sourcePath === "stockIdeaView.rows[0].symbol") {
    const rows = rowsFromView(output, "stockIdeaView");
    return typeof rows[0]?.symbol === "string" ? rows[0].symbol : undefined;
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
  const validation = validateResearchWorkflow(input.plan);
  if (!validation.ok) {
    return {
      handled: false,
      warnings: [
        "The compound research request could not be safely expanded into bounded checks.",
      ],
    };
  }
  const workflow = validation.workflow;
  if (!workflow) {
    return {
      handled: false,
      warnings: [
        "The requested multi-step research plan is outside the currently supported bounded execution path.",
      ],
    };
  }

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
  const regimeResult = await runPlannerPgCapability(input, capabilityClassification(
    input.classification,
    "market_regime_historical_playbook",
  ));
  warnings.push(...regimeResult.warnings);
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
    });
  }
  const screenResults = await runSectorFeatureScreens(
    input,
    sectors,
    "The screen is constrained to sectors that historically led in the current regime playbook.",
  );
  warnings.push(...screenResults.warnings);
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
  });
}

async function executeSectorDeltaToStockScreen(
  input: ResearchPlanExecutionInput,
  workflow: ResearchWorkflowMatch,
): Promise<ResearchPlanExecutionResult> {
  const warnings: string[] = [];
  const deltaResult = await runPlannerPgCapability(input, capabilityClassification(
    input.classification,
    "week_over_week_sector_delta",
  ));
  warnings.push(...deltaResult.warnings);
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
    });
  }
  const screenResults = await runSectorFeatureScreens(
    input,
    sectors,
    "The screen is constrained to sectors that improved in the weekly public sector delta view.",
  );
  warnings.push(...screenResults.warnings);
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
  });
}

async function executeSectorDivergenceToStockScreen(
  input: ResearchPlanExecutionInput,
  workflow: ResearchWorkflowMatch,
): Promise<ResearchPlanExecutionResult> {
  const warnings: string[] = [];
  const divergenceResult = await runPlannerPgCapability(input, capabilityClassification(
    input.classification,
    "sector_momentum_vs_conviction_divergence",
  ));
  warnings.push(...divergenceResult.warnings);
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
    });
  }
  const screenResults = await runSectorFeatureScreens(
    input,
    sectors,
    "The screen is constrained to sectors with public conviction-versus-price divergence.",
  );
  warnings.push(...screenResults.warnings);
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
  const screenResult = await runPlannerPgCapability(input, {
    ...capabilityClassification(input.classification, "feature_screen"),
    featureCriteria: criteria,
  });
  warnings.push(...screenResult.warnings);
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
  return {
    handled: true,
    pgCapabilityViews: {
      ...(featureScreenView ? { featureScreenView } : {}),
      ...backtestResult.views,
    },
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
  // Pull a sibling sector research object so the agent can do the
  // stock-vs-sector comparison directly from research objects. The sector
  // is inferred from the stock's research object when available.
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

function inferSectorFromResearchObjects(
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

async function executeIdeaToCompareAndRisk(
  input: ResearchPlanExecutionInput,
  workflow: ResearchWorkflowMatch,
): Promise<ResearchPlanExecutionResult> {
  const warnings: string[] = [];
  const ideaResult = await runPlannerPgCapability(input, capabilityClassification(
    input.classification,
    "stock_idea_discovery",
  ));
  warnings.push(...ideaResult.warnings);
  const ideaView = ideaResult.views.stockIdeaView;
  const symbol = topStockIdeaSymbol(ideaView);
  if (!symbol) {
    warnings.push("No current stock idea candidate was available for comparison and risk checks.");
    return {
      handled: true,
      pgCapabilityViews: ideaResult.views,
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
}): ResearchPlanExecutionResult {
  return {
    handled: true,
    pgCapabilityViews: input.pgCapabilityViews,
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
  return {
    view: mergeFeatureScreenViews(sectors, views, constraintWarning),
    warnings: unique(warnings),
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

function numberParam(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
