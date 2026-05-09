import { observeToolCall } from "../../langfuse";
import {
  buildResearchObjects,
  buildResearchObjectsForAnchors,
} from "../researchObjectBuilder";
import {
  inferIndustryFromResearchObjects,
  inferSectorFromResearchObjects,
} from "../researchPlanner";
import {
  EMPTY_CLASSIFICATION,
  type AskGrahamyState,
  type CachedResearchObject,
} from "../types";
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
        ...(state.asOfDate ? { asOfDate: state.asOfDate } : {}),
      }),
  );

  const objects = [...result.objects];
  const objectsUpdated = [...result.objectsUpdated];
  const warnings = [...result.warnings];
  const stats = { ...result.stats };

  // Sibling auto-load: when the user anchored on a single stock and didn't
  // name a sector or industry this turn, derive them from the just-built
  // stock RO and load the sibling sector and industry ROs alongside. This
  // makes peer-comparison follow-ups ("how does X compare to its sector /
  // industry / peers?") answer with first-class evidence — without forcing
  // the classifier to name anchors the user didn't say.
  if (
    classification.symbols.length === 1 &&
    classification.sectors.length === 0 &&
    classification.industries.length === 0
  ) {
    const sibling = await loadSiblingSectorAndIndustry(
      objects,
      state.priorResearchObjects ?? [],
      state.snapshots ?? {},
      state.toolOutputs ?? {},
      state.asOfDate,
    );
    objects.push(...sibling.objects);
    objectsUpdated.push(...sibling.objectsUpdated);
    warnings.push(...sibling.warnings);
    stats.hits += sibling.stats.hits;
    stats.misses += sibling.stats.misses;
    stats.writes += sibling.stats.writes;
  }

  state.researchObjects = objects;
  state.researchObjectsUpdated = objectsUpdated;
  state.researchObjectCacheStats = stats;
  state.warnings.push(...warnings);
}

/**
 * Build the sibling sector + sibling industry ROs for a single-stock turn
 * by reading `publicSummary.sector`/`publicSummary.industry` off the
 * just-built stock RO. Skips either side if the value isn't present or
 * if the corresponding RO already loaded as part of the main build (e.g.
 * because the classifier named it explicitly).
 */
async function loadSiblingSectorAndIndustry(
  objects: CachedResearchObject[],
  priorResearchObjects: CachedResearchObject[],
  snapshots: AskGrahamyState["snapshots"],
  toolOutputs: AskGrahamyState["toolOutputs"],
  asOfDate: string | undefined,
): Promise<{
  objects: CachedResearchObject[];
  objectsUpdated: CachedResearchObject[];
  warnings: string[];
  stats: { hits: number; misses: number; writes: number };
}> {
  const sectorAnchor = inferSectorFromResearchObjects(objects);
  const industryAnchor = inferIndustryFromResearchObjects(objects);
  const haveSectorAlready = objects.some(
    (item) =>
      item.objectType === "sector" &&
      item.anchor.toLowerCase() === (sectorAnchor ?? "").toLowerCase(),
  );
  const haveIndustryAlready = objects.some(
    (item) =>
      item.objectType === "industry" &&
      item.anchor.toLowerCase() === (industryAnchor ?? "").toLowerCase(),
  );
  const sectors = sectorAnchor && !haveSectorAlready ? [sectorAnchor] : [];
  const industries =
    industryAnchor && !haveIndustryAlready ? [industryAnchor] : [];
  if (!sectors.length && !industries.length) {
    return {
      objects: [],
      objectsUpdated: [],
      warnings: [],
      stats: { hits: 0, misses: 0, writes: 0 },
    };
  }
  const sibling = await buildResearchObjectsForAnchors({
    sectors,
    industries,
    snapshots: snapshots ?? {},
    toolOutputs: toolOutputs ?? {},
    priorResearchObjects,
    ...(asOfDate ? { asOfDate } : {}),
  });
  return {
    objects: sibling.objects,
    objectsUpdated: sibling.objectsUpdated,
    warnings: sibling.warnings,
    stats: sibling.stats,
  };
}
