import { observeToolCall } from "../../langfuse";
import { executePipelineOverlays } from "../pipelineOverlays/registry";
import { EMPTY_CLASSIFICATION, type AskGrahamyState } from "../types";
import {
  type AskGrahamyGraphState,
  type AskGrahamyLangGraphState,
  patchFromAskGrahamyState,
  type RunAskGrahamyGraphOptions,
  runGraphNode,
  toAskGrahamyState,
} from "../askGrahamyState";

export async function loadPipelineOverlaysNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    await loadPipelineOverlays(
      next,
      state.options?.executionMode ?? "live",
      state.options.pipelineOverlayRunner,
    );
    return patchFromAskGrahamyState(next);
  });
}

async function loadPipelineOverlays(
  state: AskGrahamyState,
  executionMode: "live" | "landing_warm",
  runner?: RunAskGrahamyGraphOptions["pipelineOverlayRunner"],
): Promise<void> {
  if (executionMode !== "landing_warm") {
    state.pipelineOverlayViews = {};
    return;
  }

  const classification = state.classification ?? EMPTY_CLASSIFICATION;
  const input = {
    classification,
    message: state.message,
  };
  const result = await observeToolCall(
    "execute_pipeline_overlays",
    {
      message: state.message,
      intent: classification.intent,
      focus: classification.focus,
    },
    () => (runner ?? executePipelineOverlays)(input),
  );
  state.pipelineOverlayViews = result.views;
  state.warnings.push(...result.warnings);
}
