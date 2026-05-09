import { observeToolCall } from "../../langfuse";
import { buildResearchObjects } from "../researchObjectBuilder";
import { EMPTY_CLASSIFICATION, type AskGrahamyState } from "../types";
import {
  type AskGrahamyGraphState,
  type AskGrahamyLangGraphState,
  patchFromAskGrahamyState,
  runGraphNode,
  toAskGrahamyState,
} from "../askGrahamyState";

export async function loadResearchObjectsNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    await loadResearchObjects(next);
    return patchFromAskGrahamyState(next);
  });
}

async function loadResearchObjects(state: AskGrahamyState): Promise<void> {
  if (
    state.classification?.focus === "validated_evidence" ||
    state.classification?.intent === "platform_help"
  ) {
    state.researchObjects = [];
    state.researchObjectsUpdated = [];
    state.researchObjectCacheStats = { hits: 0, misses: 0, writes: 0 };
    return;
  }
  const classification = state.classification ?? EMPTY_CLASSIFICATION;
  const result = await observeToolCall(
    "build_research_objects",
    {
      symbols: classification.symbols,
      sectors: classification.sectors,
      priorObjectCount: state.priorResearchObjects?.length ?? 0,
    },
    () =>
      buildResearchObjects({
        classification,
        snapshots: state.snapshots ?? {},
        toolOutputs: state.toolOutputs ?? {},
        priorResearchObjects: state.priorResearchObjects ?? [],
      }),
  );
  state.researchObjects = result.objects;
  state.researchObjectsUpdated = result.objectsUpdated;
  state.researchObjectCacheStats = result.stats;
  state.warnings.push(...result.warnings);
}
