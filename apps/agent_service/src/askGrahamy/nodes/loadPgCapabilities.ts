import { observeToolCall } from "../../langfuse";
import { executePgCapabilitiesWithCache } from "../pgCapabilities/registry";
import { EMPTY_CLASSIFICATION, type AskGrahamyState } from "../types";
import {
  type AskGrahamyGraphState,
  type AskGrahamyLangGraphState,
  patchFromAskGrahamyState,
  type RunAskGrahamyGraphOptions,
  runGraphNode,
  toAskGrahamyState,
} from "../askGrahamyState";

export async function loadPgCapabilitiesNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    await loadPgCapabilities(next, state.options.pgCapabilityRunner);
    return patchFromAskGrahamyState(next);
  });
}

async function loadPgCapabilities(
  state: AskGrahamyState,
  runner?: RunAskGrahamyGraphOptions["pgCapabilityRunner"],
): Promise<void> {
  const classification = state.classification ?? EMPTY_CLASSIFICATION;
  const input = {
    classification,
    message: state.message,
    snapshots: state.snapshots ?? {},
    toolOutputs: state.toolOutputs ?? {},
  };
  const result = await observeToolCall(
    "execute_pg_capabilities",
    {
      message: state.message,
      intent: classification.intent,
      symbols: classification.symbols,
      sectors: classification.sectors,
      priorCapabilityViewCount: state.priorCapabilityViews?.length ?? 0,
    },
    () =>
      executePgCapabilitiesWithCache(
        input,
        state.priorCapabilityViews ?? [],
        runner,
      ),
  );
  state.pgCapabilityViews = result.views;
  state.capabilityViewsUpdated = result.viewsUpdated;
  state.capabilityViewCacheStats = result.cacheStats;
  state.warnings.push(...result.warnings);
}
