import { executeSnapshotTools } from "../tools";
import { EMPTY_CLASSIFICATION, type AskGrahamyState } from "../types";
import {
  type AskGrahamyGraphState,
  type AskGrahamyLangGraphState,
  patchFromAskGrahamyState,
  runGraphNode,
  toAskGrahamyState,
} from "../askGrahamyState";

export async function executeToolsNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    await executeTools(next);
    return patchFromAskGrahamyState(next);
  });
}

async function executeTools(state: AskGrahamyState): Promise<void> {
  state.toolOutputs = await executeSnapshotTools(
    state.selectedTools ?? [],
    state.snapshots ?? {},
    state.classification ?? EMPTY_CLASSIFICATION,
  );
}
