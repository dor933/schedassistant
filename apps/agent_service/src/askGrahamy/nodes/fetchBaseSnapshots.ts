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
  // First coarse stage boundary — the graph has just validated the
  // classification and is about to fan out the read path. Anything
  // before this is sub-100ms validation noise that wouldn't render as
  // a chip anyway.
  state.options?.emitProgress?.({
    stage: "market-context",
    label: "Reading market context",
  });
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
