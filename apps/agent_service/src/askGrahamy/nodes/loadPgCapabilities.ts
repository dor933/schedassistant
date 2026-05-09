import { observeToolCall } from "../../langfuse";
import { executePgCapabilitiesWithCache } from "../pgCapabilities/registry";
import {
  EMPTY_CLASSIFICATION,
  type AskGrahamyState,
  type CachedResearchObject,
  type ResponseMeta,
} from "../types";
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
    priorResearchObjects: mergeCachedResearchObjects(
      state.priorResearchObjects ?? [],
      state.researchObjects ?? [],
    ),
    // Forward the canonical PG asOfDate so capability cache keys + every
    // child RO the capability fans out land on the SAME date the SS-side
    // cache used. Without this, the capability path silently falls back
    // to pipeline freshness and SS priors miss.
    ...(state.asOfDate ? { asOfDate: state.asOfDate } : {}),
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
  state.researchObjects = mergeCachedResearchObjects(
    state.researchObjects ?? [],
    result.researchObjects ?? [],
  );
  state.researchObjectsUpdated = mergeCachedResearchObjects(
    state.researchObjectsUpdated ?? [],
    result.researchObjectsUpdated ?? [],
  );
  state.researchObjectCacheStats = mergeResearchObjectCacheStats(
    state.researchObjectCacheStats,
    result.researchObjectCacheStats,
  );
  state.warnings.push(...result.warnings);
}

function mergeCachedResearchObjects(
  first: CachedResearchObject[],
  second: CachedResearchObject[],
): CachedResearchObject[] {
  const byKey = new Map<string, CachedResearchObject>();
  for (const item of [...first, ...second]) {
    if (!item.cacheKey || byKey.has(item.cacheKey)) continue;
    byKey.set(item.cacheKey, item);
  }
  return [...byKey.values()];
}

function mergeResearchObjectCacheStats(
  first: ResponseMeta["researchObjectCache"] | undefined,
  second: ResponseMeta["researchObjectCache"] | undefined,
): ResponseMeta["researchObjectCache"] | undefined {
  if (!first) return second;
  if (!second) return first;
  return {
    hits: first.hits + second.hits,
    misses: first.misses + second.misses,
    writes: first.writes + second.writes,
  };
}
