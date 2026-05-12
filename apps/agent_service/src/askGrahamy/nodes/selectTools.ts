import type { AskGrahamyState } from "../types";
import {
  type AskGrahamyGraphState,
  type AskGrahamyLangGraphState,
  patchFromAskGrahamyState,
  runGraphNode,
  toAskGrahamyState,
} from "../state/askGrahamyState";

export async function selectToolsNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    selectTools(next);
    return patchFromAskGrahamyState(next);
  });
}

function selectTools(state: AskGrahamyState): void {
  state.selectedTools = state.classification?.requiresTools ?? [];
}
