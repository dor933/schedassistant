import { observeToolCall } from "../../langfuse";
import { logger } from "../../logger";
import {
  buildResearchWorkflowPlan,
  executeResearchPlan,
  shouldRunResearchPlanner,
} from "../researchPlanner";
import { EMPTY_CLASSIFICATION, type AskGrahamyState } from "../types";
import {
  type AskGrahamyGraphState,
  type AskGrahamyLangGraphState,
  patchFromAskGrahamyState,
  runGraphNode,
  toAskGrahamyState,
} from "../askGrahamyState";

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
  options: AskGrahamyGraphState["options"],
): Promise<boolean> {
  const classification = state.classification ?? EMPTY_CLASSIFICATION;
  if (!shouldRunResearchPlanner(state.message, classification)) return false;

  // shouldRunResearchPlanner already gated on classification.compoundWorkflow
  // and the stock_deep_dive_stack symbol-availability check.
  const workflowName = classification.compoundWorkflow;
  if (!workflowName) return false;

  try {
    const plan = buildResearchWorkflowPlan(workflowName, state.message);
    const executor = options.researchPlanExecutor ?? executeResearchPlan;
    const execution = await observeToolCall(
      "execute_research_plan",
      {
        message: state.message,
        workflowName,
        steps: plan.steps.map((step) => ({
          id: step.id,
          capability: step.capability,
        })),
      },
      () =>
        executor({
          workflowName,
          plan,
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
