import crypto from "node:crypto";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { logger } from "../logger";
import { classifyMessage, type ClassifyOptions } from "./classification";
import { buildSafeErrorAnswer } from "./answerTemplates";
import { runMoatGuard } from "./moatGuard";
import { compilePublicResearchView } from "./publicResearch";
import { buildResearchObjects } from "./researchObjectBuilder";
import { GrahamySnapshotClient } from "./snapshotClient";
import { executeSnapshotTools } from "./tools";
import { runGrahamyDeepAgent } from "./grahamyAgent";
import {
  buildAnalystBriefContract,
  buildEvidencePack,
} from "./analystOrchestration";
import {
  synthesizeAnalystBriefFromEvidencePack,
  type AnalystBriefSynthesisInput,
  type AnalystBriefSynthesisResult,
} from "./analystBriefSynthesizer";
import { renderAnalystBriefToAnswer } from "./analystBriefRenderer";
import { buildEvidencePackFromWorkflowExecution } from "./workflowEvidencePack";
import {
  buildFallbackResearchPlan,
  executeResearchPlan,
  proposeResearchPlan,
  shouldRunResearchPlanner,
  validateResearchWorkflow,
  type ResearchPlan,
  type ResearchPlanExecutor,
} from "./researchPlanner";
import { executePgCapabilitiesWithCache } from "./pgCapabilities/registry";
import { executePipelineOverlays } from "./pipelineOverlays/registry";
import type {
  CachedCapabilityView,
  PgCapabilityRunInput,
  PgCapabilityRunResult,
} from "./pgCapabilities/types";
import type {
  PipelineOverlayRunInput,
  PipelineOverlayRunResult,
} from "./pipelineOverlays/registry";
import {
  DEFAULT_DISCLAIMER,
  EMPTY_CLASSIFICATION,
  EMPTY_PUBLIC_RESEARCH_VIEW,
  type AskGrahamyRequest,
  type AskGrahamyResponse,
  type AskGrahamyState,
  type CachedResearchObject,
  type Classification,
  type ResponseMeta,
  type SnapshotBundle,
  type ToolName,
} from "./types";

type SnapshotClient = Pick<GrahamySnapshotClient, "fetchPublishedSnapshots">;

export type RunAskGrahamyGraphOptions = {
  snapshotClient?: SnapshotClient;
  // Test seam — lets graph.test.ts run without a live LLM. Production code
  // leaves this undefined so classification falls back to the model-backed
  // classifier configured in classification.ts.
  classifier?: ClassifyOptions["classifier"];
  /**
   * Test seam for the underlying capability SQL run. Returns the raw
   * `{views, warnings}` shape — `loadPgCapabilities` wraps this in cache
   * lookup/write logic via `executePgCapabilitiesWithCache`. Production
   * code leaves this undefined so `executePgCapabilities` is used.
   */
  pgCapabilityRunner?: (
    input: PgCapabilityRunInput,
  ) => Promise<PgCapabilityRunResult>;
  pipelineOverlayRunner?: (
    input: PipelineOverlayRunInput,
  ) => Promise<PipelineOverlayRunResult>;
  researchPlanProposer?: (message: string) => Promise<ResearchPlan>;
  researchPlanExecutor?: ResearchPlanExecutor;
  analystBriefSynthesizer?: (
    input: AnalystBriefSynthesisInput,
  ) => Promise<AnalystBriefSynthesisResult>;
  researchObjectBuilder?: typeof buildResearchObjects;
  grahamyAgentRunner?: typeof runGrahamyDeepAgent;
};

const RESEARCH_PLANNER_TIMEOUT_MS = Number(
  process.env.ASK_GRAHAMY_RESEARCH_PLANNER_TIMEOUT_MS ?? 10_000,
);

type AskGrahamyGraphState = AskGrahamyState & {
  options: RunAskGrahamyGraphOptions;
  snapshotClient: SnapshotClient;
  plannerHandled: boolean;
  response?: AskGrahamyResponse;
  error?: string;
};

function replaceStateValue<T>(state: T, update: T): T {
  return update !== undefined ? update : state;
}

const AskGrahamyGraphAnnotation = Annotation.Root({
  internalUserId: Annotation<number>({
    reducer: replaceStateValue,
    default: () => 0,
  }),
  conversationId: Annotation<AskGrahamyState["conversationId"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  message: Annotation<string>({
    reducer: replaceStateValue,
    default: () => "",
  }),
  messageId: Annotation<AskGrahamyState["messageId"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  previousContext: Annotation<AskGrahamyState["previousContext"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  classification: Annotation<AskGrahamyState["classification"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  snapshots: Annotation<AskGrahamyState["snapshots"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  selectedTools: Annotation<AskGrahamyState["selectedTools"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  toolOutputs: Annotation<AskGrahamyState["toolOutputs"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  priorResearchObjects: Annotation<AskGrahamyState["priorResearchObjects"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  researchObjects: Annotation<AskGrahamyState["researchObjects"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  researchObjectsUpdated: Annotation<AskGrahamyState["researchObjectsUpdated"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  researchObjectCacheStats: Annotation<AskGrahamyState["researchObjectCacheStats"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  priorCapabilityViews: Annotation<AskGrahamyState["priorCapabilityViews"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  pgCapabilityViews: Annotation<AskGrahamyState["pgCapabilityViews"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  pipelineOverlayViews: Annotation<AskGrahamyState["pipelineOverlayViews"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  compoundResearchContext: Annotation<AskGrahamyState["compoundResearchContext"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  workflowExecutionResult: Annotation<AskGrahamyState["workflowExecutionResult"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  evidencePack: Annotation<AskGrahamyState["evidencePack"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  analystBrief: Annotation<AskGrahamyState["analystBrief"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  capabilityViewsUpdated: Annotation<AskGrahamyState["capabilityViewsUpdated"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  capabilityViewCacheStats: Annotation<AskGrahamyState["capabilityViewCacheStats"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  publicResearchView: Annotation<AskGrahamyState["publicResearchView"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  answer: Annotation<AskGrahamyState["answer"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  ui: Annotation<AskGrahamyState["ui"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  meta: Annotation<AskGrahamyState["meta"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  warnings: Annotation<string[]>({
    reducer: replaceStateValue,
    default: () => [],
  }),
  options: Annotation<RunAskGrahamyGraphOptions>({
    reducer: replaceStateValue,
    default: () => ({}),
  }),
  snapshotClient: Annotation<SnapshotClient>({
    reducer: replaceStateValue,
    default: () => new GrahamySnapshotClient(),
  }),
  plannerHandled: Annotation<boolean>({
    reducer: replaceStateValue,
    default: () => false,
  }),
  response: Annotation<AskGrahamyResponse | undefined>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  error: Annotation<string | undefined>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
});

type AskGrahamyLangGraphState = typeof AskGrahamyGraphAnnotation.State;

function routeAfterNode(state: AskGrahamyLangGraphState): "next" | "error" {
  return state.error ? "error" : "next";
}

function routeAfterResearchPlanner(
  state: AskGrahamyLangGraphState,
): "plannerHandled" | "standardLoaders" | "error" {
  if (state.error) return "error";
  return state.plannerHandled ? "plannerHandled" : "standardLoaders";
}

const askGrahamyWorkflow = new StateGraph(AskGrahamyGraphAnnotation)
  .addNode("classifyIntent", classifyIntentNode)
  .addNode("fetchBaseSnapshots", fetchBaseSnapshotsNode)
  .addNode("selectTools", selectToolsNode)
  .addNode("executeTools", executeToolsNode)
  .addNode("researchPlanner", researchPlannerNode)
  .addNode("loadResearchObjects", loadResearchObjectsNode)
  .addNode("loadPgCapabilities", loadPgCapabilitiesNode)
  .addNode("loadPipelineOverlays", loadPipelineOverlaysNode)
  .addNode("compileEvidence", compileEvidenceNode)
  .addNode("buildAnswer", answerNode)
  .addNode("buildMeta", buildMetaNode)
  .addNode("finalizeResponse", finalizeResponseNode)
  .addNode("safeErrorResponse", safeErrorResponseNode)

  .addEdge(START, "classifyIntent")
  .addConditionalEdges("classifyIntent", routeAfterNode, {
    next: "fetchBaseSnapshots",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("fetchBaseSnapshots", routeAfterNode, {
    next: "selectTools",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("selectTools", routeAfterNode, {
    next: "executeTools",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("executeTools", routeAfterNode, {
    next: "researchPlanner",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("researchPlanner", routeAfterResearchPlanner, {
    plannerHandled: "compileEvidence",
    standardLoaders: "loadResearchObjects",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("loadResearchObjects", routeAfterNode, {
    next: "loadPgCapabilities",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("loadPgCapabilities", routeAfterNode, {
    next: "loadPipelineOverlays",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("loadPipelineOverlays", routeAfterNode, {
    next: "compileEvidence",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("compileEvidence", routeAfterNode, {
    next: "buildAnswer",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("buildAnswer", routeAfterNode, {
    next: "buildMeta",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("buildMeta", routeAfterNode, {
    next: "finalizeResponse",
    error: "safeErrorResponse",
  })
  .addEdge("finalizeResponse", END)
  .addEdge("safeErrorResponse", END);

const compiledAskGrahamyWorkflow = askGrahamyWorkflow.compile();

export { askGrahamyWorkflow };

/**
 * askGrahamy graph — runs once per StocksScanner turn.
 *
 *   classify (skip if SS already supplied) -> fetch base snapshots ->
 *   execute snapshot tools -> research planner ->
 *     planner handled: compile evidence -> synthesize answer -> moat guard
 *     standard path: load research objects/capabilities/overlays ->
 *       compile evidence -> invoke Grahamy deep agent -> moat guard.
 *
 * Conversation memory lives in PostgresSaver via `thread_id = conversationId`,
 * NOT in a separate JSON conversation store. Follow-up resolution happens
 * naturally inside the agent — no per-classifier follow-up branch needed.
 */
export async function runAskGrahamyGraph(
  request: AskGrahamyRequest,
  internalUserId: number,
  options: RunAskGrahamyGraphOptions = {},
): Promise<AskGrahamyResponse> {
  // Caller (StocksScanner) may have already classified + pre-loaded its
  // local research objects via POST /api/ask-grahamy/classify. When supplied
  // we skip the LLM classify call and treat the prior objects as cache hits.
  const suppliedClassification =
    (request as { classification?: Classification }).classification;
  const suppliedPriorObjects =
    (request as { priorResearchObjects?: CachedResearchObject[] }).priorResearchObjects;
  const suppliedPriorCapabilityViews =
    (request as { priorCapabilityViews?: CachedCapabilityView[] })
      .priorCapabilityViews;

  const state: AskGrahamyState = {
    internalUserId,
    conversationId: request.conversationId ?? undefined,
    message: request.message,
    warnings: [],
    classification: suppliedClassification,
    priorResearchObjects: suppliedPriorObjects,
    priorCapabilityViews: suppliedPriorCapabilityViews,
  };

  // Ensure we have a conversationId — the deep agent uses it as PostgresSaver
  // thread_id. SS normally supplies one (per chat in its UI); we generate
  // a UUID only as a fallback for direct callers.
  state.conversationId = state.conversationId || crypto.randomUUID();
  state.messageId = crypto.randomUUID();

  const snapshotClient = options.snapshotClient ?? new GrahamySnapshotClient();
  const graphState: AskGrahamyGraphState = {
    ...state,
    options,
    snapshotClient,
    plannerHandled: false,
  };

  try {
    const finalState = await compiledAskGrahamyWorkflow.invoke(graphState);
    if (finalState.response) return finalState.response;
    const missingResponseError = finalState.error
      ? new Error(finalState.error)
      : new Error("Ask Grahamy graph completed without a response.");
    return await finalizeSafeGraphError(
      toAskGrahamyState(finalState),
      missingResponseError,
    );
  } catch (err) {
    return await finalizeSafeGraphError(state, err);
  }
}

function toAskGrahamyState(
  state: AskGrahamyLangGraphState | AskGrahamyGraphState,
): AskGrahamyState {
  return {
    ...state,
    warnings: [...(state.warnings ?? [])],
  };
}

function patchFromAskGrahamyState(
  state: AskGrahamyState,
): Partial<AskGrahamyGraphState> {
  return {
    ...state,
    warnings: [...state.warnings],
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runGraphNode(
  state: AskGrahamyLangGraphState,
  action: () => Promise<Partial<AskGrahamyGraphState>>,
): Promise<Partial<AskGrahamyGraphState>> {
  if (state.error) return {};
  try {
    return await action();
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

async function classifyIntentNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    if (!next.classification) {
      await classifyIntent(next, state.options.classifier);
    }
    return patchFromAskGrahamyState(next);
  });
}

async function fetchBaseSnapshotsNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    await fetchBaseSnapshots(next, state.snapshotClient);
    return patchFromAskGrahamyState(next);
  });
}

async function selectToolsNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    selectTools(next);
    return patchFromAskGrahamyState(next);
  });
}

async function executeToolsNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    await executeTools(next);
    return patchFromAskGrahamyState(next);
  });
}

async function researchPlannerNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    const plannerHandled = await maybeRunResearchPlanner(next, state.options);
    return {
      ...patchFromAskGrahamyState(next),
      plannerHandled,
    };
  });
}

async function loadResearchObjectsNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    await loadResearchObjects(next);
    return patchFromAskGrahamyState(next);
  });
}

async function loadPgCapabilitiesNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    await loadPgCapabilities(next, state.options.pgCapabilityRunner);
    return patchFromAskGrahamyState(next);
  });
}

async function loadPipelineOverlaysNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    await loadPipelineOverlays(next, state.options.pipelineOverlayRunner);
    return patchFromAskGrahamyState(next);
  });
}

async function compileEvidenceNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    next.publicResearchView = compilePublicResearchView({
      classification: next.classification ?? EMPTY_CLASSIFICATION,
      previousContext: undefined,
      snapshots: next.snapshots ?? {},
      toolOutputs: next.toolOutputs ?? {},
      researchObjects: next.researchObjects ?? [],
      pgCapabilityViews: next.pgCapabilityViews,
      pipelineOverlayViews: next.pipelineOverlayViews,
      warnings: next.warnings,
    });
    next.evidencePack = next.workflowExecutionResult
      ? buildEvidencePackFromWorkflowExecution(next.workflowExecutionResult)
      : buildEvidencePack(next);
    next.analystBrief = buildAnalystBriefContract(next.evidencePack);
    return patchFromAskGrahamyState(next);
  });
}

async function answerNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    if (next.workflowExecutionResult) {
      next.evidencePack =
        next.evidencePack ??
        buildEvidencePackFromWorkflowExecution(next.workflowExecutionResult);
      const synthesis = await (
        state.options.analystBriefSynthesizer ??
        synthesizeAnalystBriefFromEvidencePack
      )({
        message: next.message,
        evidencePack: next.evidencePack,
      });
      next.warnings.push(...synthesis.warnings);
      next.analystBrief = synthesis.brief;
      const rendered = renderAnalystBriefToAnswer(synthesis.brief);
      next.answer = rendered.answer;
      next.ui = rendered.ui;
    } else {
      // The deep agent composes the user-facing answer from the turn evidence
      // and its own PostgresSaver thread history keyed by conversationId.
      const grahamy = await (
        state.options.grahamyAgentRunner ?? runGrahamyDeepAgent
      )(next);
      next.warnings.push(...grahamy.warnings);
      next.answer = {
        headline: "",
        summary: grahamy.answerText,
        bullets: [],
        watchpoints: [],
        disclaimer: DEFAULT_DISCLAIMER,
      };
      next.ui = {
        cards: [],
        tables: [],
        suggestedFollowups: grahamy.suggestedFollowups,
      };
    }
    return patchFromAskGrahamyState(next);
  });
}

async function buildMetaNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    next.meta = buildMeta(
      next.selectedTools ?? [],
      next.snapshots ?? {},
      next.warnings,
      next.classification ?? EMPTY_CLASSIFICATION,
      next.researchObjects ?? [],
      next.researchObjectCacheStats,
      next.researchObjectsUpdated ?? [],
      next.pgCapabilityViews,
      next.capabilityViewsUpdated ?? [],
      next.capabilityViewCacheStats,
      next.pipelineOverlayViews,
    );
    return patchFromAskGrahamyState(next);
  });
}

async function finalizeResponseNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    const response = await finalizeResponse(next);
    return {
      ...patchFromAskGrahamyState(next),
      response,
    };
  });
}

async function safeErrorResponseNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  const next = toAskGrahamyState(state);
  const response = await finalizeSafeGraphError(
    next,
    new Error(state.error ?? "Unknown Ask Grahamy graph error."),
  );
  return {
    ...patchFromAskGrahamyState(next),
    response,
  };
}

async function finalizeSafeGraphError(
  state: AskGrahamyState,
  err: unknown,
): Promise<AskGrahamyResponse> {
  logger.error("Ask Grahamy graph failed", {
    userId: state.internalUserId,
    conversationId: state.conversationId,
    messageId: state.messageId,
    error: errorMessage(err),
  });
  state.answer = buildSafeErrorAnswer();
  state.classification = state.classification ?? EMPTY_CLASSIFICATION;
  state.publicResearchView = state.publicResearchView ?? EMPTY_PUBLIC_RESEARCH_VIEW;
  state.ui = state.ui ?? { cards: [], tables: [], suggestedFollowups: [] };
  state.meta = buildMeta(
    state.selectedTools ?? [],
    state.snapshots ?? {},
    [
      ...state.warnings,
      "Ask Grahamy failed before a safe answer could be completed.",
    ],
    state.classification,
  );
  return await finalizeResponse(state, "error");
}

async function classifyIntent(
  state: AskGrahamyState,
  classifier?: ClassifyOptions["classifier"],
): Promise<void> {
  state.classification = await classifyMessage(state.message, undefined, {
    classifier,
  });
  state.warnings.push(...state.classification.warnings);
}

async function fetchBaseSnapshots(
  state: AskGrahamyState,
  snapshotClient: SnapshotClient,
): Promise<void> {
  state.snapshots = await snapshotClient.fetchPublishedSnapshots();
  if (state.snapshots.freshness?.staleReason) {
    state.warnings.push(state.snapshots.freshness.staleReason);
  }
}

function selectTools(state: AskGrahamyState): void {
  state.selectedTools = state.classification?.requiresTools ?? [];
}

async function executeTools(state: AskGrahamyState): Promise<void> {
  state.toolOutputs = await executeSnapshotTools(
    state.selectedTools ?? [],
    state.snapshots ?? {},
    state.classification ?? EMPTY_CLASSIFICATION,
  );
}

async function maybeRunResearchPlanner(
  state: AskGrahamyState,
  options: RunAskGrahamyGraphOptions,
): Promise<boolean> {
  const classification = state.classification ?? EMPTY_CLASSIFICATION;
  if (!shouldRunResearchPlanner(state.message, classification)) {
    return false;
  }

  try {
    const usingDefaultProposer = !options.researchPlanProposer;
    const proposer = options.researchPlanProposer ?? proposeResearchPlan;
    let plan: ResearchPlan;
    try {
      plan = await withPlannerTimeout(
        proposer(state.message),
        RESEARCH_PLANNER_TIMEOUT_MS,
      );
    } catch (err) {
      const fallbackPlan = buildFallbackResearchPlan(state.message);
      if (!fallbackPlan) throw err;
      logger.warn("Ask Grahamy research planner used approved workflow fallback", {
        conversationId: state.conversationId,
        messageId: state.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      plan = fallbackPlan;
    }
    let validation = validateResearchWorkflow(plan);
    if (!validation.ok && usingDefaultProposer) {
      const fallbackPlan = buildFallbackResearchPlan(state.message);
      if (fallbackPlan) {
        const fallbackValidation = validateResearchWorkflow(fallbackPlan);
        if (fallbackValidation.ok) {
          logger.warn("Ask Grahamy research planner validation repaired with approved workflow fallback", {
            conversationId: state.conversationId,
            messageId: state.messageId,
            errors: validation.errors,
          });
          validation = fallbackValidation;
        }
      }
    }
    if (!validation.ok) {
      state.warnings.push(
        "The compound research request could not be safely expanded into bounded checks; using the available standard analysis.",
      );
      logger.warn("Ask Grahamy research planner validation failed", {
        conversationId: state.conversationId,
        messageId: state.messageId,
        errors: validation.errors,
      });
      return false;
    }

    const executor = options.researchPlanExecutor ?? executeResearchPlan;
    const execution = await executor({
      plan: validation.plan,
      message: state.message,
      classification,
      snapshots: state.snapshots ?? {},
      toolOutputs: state.toolOutputs ?? {},
      priorResearchObjects: state.priorResearchObjects ?? [],
      researchObjectBuilder: options.researchObjectBuilder,
      pgCapabilityRunner: options.pgCapabilityRunner,
      pipelineOverlayRunner: options.pipelineOverlayRunner,
    });
    if (execution.handled === false) {
      state.warnings.push(...execution.warnings);
      return false;
    }
    state.pgCapabilityViews = {
      ...(state.pgCapabilityViews ?? {}),
      ...(execution.pgCapabilityViews ?? {}),
    };
    state.pipelineOverlayViews = {
      ...(state.pipelineOverlayViews ?? {}),
      ...(execution.pipelineOverlayViews ?? {}),
    };
    state.researchObjects = execution.researchObjects ?? [];
    state.researchObjectsUpdated = execution.researchObjectsUpdated ?? [];
    state.researchObjectCacheStats =
      execution.researchObjectCacheStats ?? { hits: 0, misses: 0, writes: 0 };
    state.capabilityViewsUpdated = [];
    state.capabilityViewCacheStats = { hits: 0, misses: 0, writes: 0 };
    state.workflowExecutionResult = execution.workflowExecutionResult;
    state.compoundResearchContext = execution.compoundResearchContext;
    state.warnings.push(...execution.warnings);
    return true;
  } catch (err) {
    state.warnings.push(
      "The compound research request could not be expanded in this turn; using the available standard analysis.",
    );
    logger.warn("Ask Grahamy research planner failed", {
      conversationId: state.conversationId,
      messageId: state.messageId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function withPlannerTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Research planner timed out after ${Math.round(ms / 1000)} seconds`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function loadResearchObjects(state: AskGrahamyState): Promise<void> {
  if (state.classification?.focus === "validated_evidence") {
    state.researchObjects = [];
    state.researchObjectsUpdated = [];
    state.researchObjectCacheStats = { hits: 0, misses: 0, writes: 0 };
    return;
  }
  const result = await buildResearchObjects({
    classification: state.classification ?? EMPTY_CLASSIFICATION,
    snapshots: state.snapshots ?? {},
    toolOutputs: state.toolOutputs ?? {},
    priorResearchObjects: state.priorResearchObjects ?? [],
  });
  state.researchObjects = result.objects;
  state.researchObjectsUpdated = result.objectsUpdated;
  state.researchObjectCacheStats = result.stats;
  state.warnings.push(...result.warnings);
}

async function loadPgCapabilities(
  state: AskGrahamyState,
  runner?: RunAskGrahamyGraphOptions["pgCapabilityRunner"],
): Promise<void> {
  const input = {
    classification: state.classification ?? EMPTY_CLASSIFICATION,
    message: state.message,
    snapshots: state.snapshots ?? {},
    toolOutputs: state.toolOutputs ?? {},
  };
  const result = await executePgCapabilitiesWithCache(
    input,
    state.priorCapabilityViews ?? [],
    runner,
  );
  state.pgCapabilityViews = result.views;
  state.capabilityViewsUpdated = result.viewsUpdated;
  state.capabilityViewCacheStats = result.cacheStats;
  state.warnings.push(...result.warnings);
}

async function loadPipelineOverlays(
  state: AskGrahamyState,
  runner?: RunAskGrahamyGraphOptions["pipelineOverlayRunner"],
): Promise<void> {
  const input = {
    classification: state.classification ?? EMPTY_CLASSIFICATION,
    message: state.message,
  };
  const result = await (runner ?? executePipelineOverlays)(input);
  state.pipelineOverlayViews = result.views;
  state.warnings.push(...result.warnings);
}

async function finalizeResponse(
  state: AskGrahamyState,
  overrideAnswerType?: AskGrahamyResponse["answerType"],
): Promise<AskGrahamyResponse> {
  const classification = state.classification ?? EMPTY_CLASSIFICATION;
  const meta =
    state.meta ??
    buildMeta(
      state.selectedTools ?? [],
      state.snapshots ?? {},
      state.warnings,
      classification,
      state.researchObjects ?? [],
      state.researchObjectCacheStats,
      state.researchObjectsUpdated ?? [],
      state.pgCapabilityViews,
      state.capabilityViewsUpdated ?? [],
      state.capabilityViewCacheStats,
      state.pipelineOverlayViews,
    );
  const response: AskGrahamyResponse = {
    conversationId: state.conversationId ?? crypto.randomUUID(),
    messageId: state.messageId ?? crypto.randomUUID(),
    answerType: overrideAnswerType ?? inferAnswerType(classification),
    classification,
    answer: state.answer ?? buildSafeErrorAnswer(),
    research: {
      publicResearchView: state.publicResearchView ?? EMPTY_PUBLIC_RESEARCH_VIEW,
    },
    ui: state.ui ?? { cards: [], tables: [], suggestedFollowups: [] },
    meta,
  };

  const guard = runMoatGuard(response);
  guard.value.meta.warnings = Array.from(
    new Set([...guard.value.meta.warnings, ...guard.warnings]),
  );
  guard.value.meta.moatGuardResult = guard.result;

  logger.info("Ask Grahamy turn completed", {
    userId: state.internalUserId,
    conversationId: guard.value.conversationId,
    messageId: guard.value.messageId,
    intent: guard.value.classification.intent,
    symbols: guard.value.classification.symbols,
    sectors: guard.value.classification.sectors,
    toolsUsed: guard.value.meta.toolsUsed,
    snapshotFreshness: guard.value.meta.freshness,
    upstreamLatency: guard.value.meta.upstreamLatency,
    warnings: guard.value.meta.warnings,
    moatGuardResult: guard.value.meta.moatGuardResult,
  });

  return guard.value;
}

function buildMeta(
  toolsUsed: ToolName[],
  snapshots: SnapshotBundle,
  warnings: string[],
  classification: Classification,
  researchObjects: import("./types").CachedResearchObject[] = [],
  researchObjectCacheStats?: import("./types").ResponseMeta["researchObjectCache"],
  researchObjectsUpdated: import("./types").CachedResearchObject[] = [],
  pgCapabilityViews?: import("./types").PgCapabilityViews,
  capabilityViewsUpdated: CachedCapabilityView[] = [],
  capabilityViewCacheStats?: import("./types").ResponseMeta["capabilityViewCache"],
  pipelineOverlayViews?: import("./types").PipelineOverlayViews,
): ResponseMeta {
  // Only research objects are "sources" the answer was actually grounded in.
  // Snapshots are background scaffolding the graph fetches for system-prompt
  // context — the agent never quotes them, so listing them as numbered
  // citations in the UI was misleading. Snapshot fetch state is still
  // captured in `freshness` / `upstreamLatency` for telemetry.
  const researchSources = researchObjects.map((item) => ({
    type: "research" as const,
    name: item.cacheKey,
  }));
  const capabilitySources: Array<{ type: "research"; name: string }> = [];
  if (pgCapabilityViews?.sectorLeaderboardView) {
    capabilitySources.push({ type: "research", name: "sector_conviction_leaderboard" });
  }
  if (pgCapabilityViews?.sectorDivergenceView) {
    capabilitySources.push({
      type: "research",
      name: "sector_momentum_vs_conviction_divergence",
    });
  }
  if (pgCapabilityViews?.sectorDeltaView) {
    capabilitySources.push({
      type: "research",
      name: "week_over_week_sector_delta",
    });
  }
  if (pgCapabilityViews?.stockIdeaView) {
    capabilitySources.push({ type: "research", name: "stock_idea_discovery" });
  }
  if (pgCapabilityViews?.featureScreenView) {
    capabilitySources.push({ type: "research", name: "feature_screen" });
  }
  if (pgCapabilityViews?.factorBacktestView) {
    capabilitySources.push({
      type: "research",
      name: "factor_conditioned_backtest",
    });
  }
  if (pgCapabilityViews?.comparisonView) {
    const comparisonType = pgCapabilityViews.comparisonView.comparisonType;
    capabilitySources.push({
      type: "research",
      name:
        comparisonType === "sector_vs_sector"
          ? "sector_vs_sector_comparison"
          : comparisonType === "symbol_vs_symbol"
            ? "symbol_vs_symbol_comparison"
            : "stock_vs_sector_comparison",
    });
  }
  if (pgCapabilityViews?.regimeHistoricalPlaybookView) {
    capabilitySources.push({
      type: "research",
      name: "market_regime_historical_playbook",
    });
  }
  if (pipelineOverlayViews?.validatedEdgeEvidenceView) {
    capabilitySources.push({
      type: "research",
      name: "validated_edge_evidence",
    });
  }
  return {
    sourcesUsed: [...researchSources, ...capabilitySources],
    freshness: snapshots.freshness ?? {},
    warnings: Array.from(
      new Set([
        ...warnings,
        ...classification.warnings,
        ...Object.values(snapshots.errors ?? {}),
      ]),
    ),
    toolsUsed,
    researchObjectKeys: researchObjects.map((item) => item.cacheKey),
    researchObjectCache: researchObjectCacheStats,
    researchObjectsUpdated: researchObjectsUpdated.length
      ? researchObjectsUpdated
      : undefined,
    capabilityViewKeys: capabilityViewsUpdated.length
      ? capabilityViewsUpdated.map((item) => item.cacheKey)
      : undefined,
    capabilityViewCache: capabilityViewCacheStats,
    capabilityViewsUpdated: capabilityViewsUpdated.length
      ? capabilityViewsUpdated
      : undefined,
    upstreamLatency: snapshots.latencyMs,
  };
}

function inferAnswerType(classification: Classification): AskGrahamyResponse["answerType"] {
  if (classification.intent === "unknown") return "unknown";
  if (classification.intent === "sector_conviction_leaderboard") return "sector";
  if (classification.intent === "sector_momentum_vs_conviction_divergence") return "sector";
  if (classification.intent === "week_over_week_sector_delta") return "sector";
  if (classification.intent === "stock_idea_discovery") return "stock";
  if (classification.intent === "feature_screen") return "stock";
  if (classification.intent === "factor_conditioned_backtest") return "stock";
  if (classification.intent === "comparison") return "mixed";
  if (classification.intent === "market_regime_historical_playbook") return "regime";
  const stock = classification.symbols.length > 0;
  const sector = classification.sectors.length > 0;
  const regime = classification.regimeRequested;
  if (stock && !sector && !regime) return "stock";
  if (sector && !stock && !regime) return "sector";
  if (regime && !stock && !sector) return "regime";
  return "mixed";
}
