import { observeToolCall } from "../../langfuse";
import { classifyMessage, type ClassifyOptions } from "../classification";
import type { AskGrahamyState } from "../types";
import {
  type AskGrahamyGraphState,
  type AskGrahamyLangGraphState,
  patchFromAskGrahamyState,
  runGraphNode,
  toAskGrahamyState,
} from "../askGrahamyState";

export async function classifyIntentNode(
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

async function classifyIntent(
  state: AskGrahamyState,
  classifier?: ClassifyOptions["classifier"],
): Promise<void> {
  state.classification = await observeToolCall(
    "classify_message",
    { message: state.message },
    () => classifyMessage(state.message, undefined, { classifier }),
  );
  state.warnings.push(...state.classification.warnings);
}
