import { observeToolCall } from "../../langfuse";
import { logger } from "../../logger";
import {
  buildFallbackResearchPlan,
  executeResearchPlan,
  proposeResearchPlan,
  shouldRunResearchPlanner,
  validateResearchWorkflow,
  type ResearchPlan,
} from "../researchPlanner";
import { EMPTY_CLASSIFICATION, type AskGrahamyState } from "../types";
import {
  type AskGrahamyGraphState,
  type AskGrahamyLangGraphState,
  patchFromAskGrahamyState,
  type RunAskGrahamyGraphOptions,
  runGraphNode,
  toAskGrahamyState,
} from "../askGrahamyState";

const RESEARCH_PLANNER_TIMEOUT_MS = Number(
  process.env.ASK_GRAHAMY_RESEARCH_PLANNER_TIMEOUT_MS ?? 10_000,
);

export async function researchPlannerNode(
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
        observeToolCall("propose_research_plan", { message: state.message }, () =>
          proposer(state.message),
        ),
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
    const execution = await observeToolCall(
      "execute_research_plan",
      {
        message: state.message,
        steps: validation.plan.steps?.map((step) => ({
          id: step.id,
          capability: step.capability,
        })),
      },
      () =>
        executor({
          plan: validation.plan,
          message: state.message,
          classification,
          snapshots: state.snapshots ?? {},
          toolOutputs: state.toolOutputs ?? {},
          priorResearchObjects: state.priorResearchObjects ?? [],
          researchObjectBuilder: options.researchObjectBuilder,
          pgCapabilityRunner: options.pgCapabilityRunner,
          pipelineOverlayRunner: options.pipelineOverlayRunner,
        }),
    );
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
    // Compound-research executors thread freshly built capability views
    // through `execution.capabilityViewsUpdated` so SS can persist them
    // into `cached_capability_views`. Previously this was hard-coded to
    // [] which meant compound-flow capability views (e.g. feature_screen
    // built inside a sector-to-screen workflow) were never persisted.
    state.capabilityViewsUpdated = execution.capabilityViewsUpdated ?? [];
    state.capabilityViewCacheStats =
      execution.capabilityViewCacheStats ?? { hits: 0, misses: 0, writes: 0 };
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
