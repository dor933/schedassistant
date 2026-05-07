import { observeToolCall } from "../../langfuse";
import type { AskGrahamyState } from "../types";
import {
  type AskGrahamyGraphState,
  type AskGrahamyLangGraphState,
  patchFromAskGrahamyState,
  runGraphNode,
  type SnapshotClient,
  toAskGrahamyState,
} from "../askGrahamyState";

export async function fetchBaseSnapshotsNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    await fetchBaseSnapshots(next, state.snapshotClient);
    return patchFromAskGrahamyState(next);
  });
}

async function fetchBaseSnapshots(
  state: AskGrahamyState,
  snapshotClient: SnapshotClient,
): Promise<void> {
  state.snapshots = await observeToolCall(
    "fetch_published_snapshots",
    {},
    () => snapshotClient.fetchPublishedSnapshots(),
  );
  if (state.snapshots.freshness?.staleReason) {
    state.warnings.push(state.snapshots.freshness.staleReason);
  }
}
