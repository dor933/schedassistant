import crypto from "node:crypto";
import { logger } from "../logger";
import { classifyMessage, type ClassifyOptions } from "./classification";
import { AskGrahamyConversationStore } from "./conversationStore";
import { buildClarificationAnswer, buildSafeErrorAnswer, buildUnknownAnswer, generateAnswerObject } from "./answerTemplates";
import { runMoatGuard } from "./moatGuard";
import { compilePublicResearchView } from "./publicResearch";
import { buildResearchObjects } from "./researchObjectBuilder";
import { GrahamySnapshotClient } from "./snapshotClient";
import { executeSnapshotTools } from "./tools";
import {
  EMPTY_CLASSIFICATION,
  EMPTY_PUBLIC_RESEARCH_VIEW,
  type AskGrahamyRequest,
  type AskGrahamyResponse,
  type AskGrahamyState,
  type CachedResearchObject,
  type Classification,
  type ResponseMeta,
  type SnapshotBundle,
  type ToolName,
} from "./types";

export type RunAskGrahamyGraphOptions = {
  snapshotClient?: GrahamySnapshotClient;
  conversationStore?: AskGrahamyConversationStore;
  // Test seam — lets graph.test.ts run without a live LLM. Production code
  // leaves this undefined so classification falls back to the Haiku-backed
  // classifier configured in classification.ts.
  classifier?: ClassifyOptions["classifier"];
};

export async function runAskGrahamyGraph(
  request: AskGrahamyRequest,
  internalUserId: number,
  options: RunAskGrahamyGraphOptions = {},
): Promise<AskGrahamyResponse> {
  // The upstream caller (StocksScanner) may have already classified the
  // message and pre-loaded its existing research objects via
  // `POST /api/ask-grahamy/classify` + a local `research_objects` lookup.
  // When supplied, we skip the LLM classify step and treat the prior objects
  // as already-cached for the per-key build loop.
  const suppliedClassification =
    (request as { classification?: Classification }).classification;
  const suppliedPriorObjects =
    (request as { priorResearchObjects?: CachedResearchObject[] }).priorResearchObjects;

  const state: AskGrahamyState = {
    internalUserId,
    conversationId: request.conversationId ?? undefined,
    message: request.message,
    warnings: [],
    classification: suppliedClassification,
    priorResearchObjects: suppliedPriorObjects,
  };
  const snapshotClient = options.snapshotClient ?? new GrahamySnapshotClient();
  const conversationStore = options.conversationStore ?? new AskGrahamyConversationStore();

  try {
    await loadConversationContext(state, conversationStore);
    if (!state.classification) {
      await classifyIntent(state, options.classifier);
    }

    if (state.classification?.intent === "follow_up" && state.classification.warnings.length) {
      const clarification = buildClarificationAnswer();
      state.answer = clarification.answer;
      state.publicResearchView = clarification.researchView;
      state.ui = clarification.ui;
      state.meta = buildMeta([], {}, state.warnings, state.classification);
      return await finalizeResponse(state, conversationStore, clarification.answerType);
    }

    if (state.classification?.intent === "unknown") {
      const unknown = buildUnknownAnswer();
      state.answer = unknown.answer;
      state.publicResearchView = unknown.researchView;
      state.ui = unknown.ui;
      state.meta = buildMeta([], {}, state.warnings, state.classification);
      return await finalizeResponse(state, conversationStore, unknown.answerType);
    }

    await fetchBaseSnapshots(state, snapshotClient);
    selectTools(state);
    await executeTools(state);
    await loadResearchObjects(state);
    compileAnswerObject(state);
    return await finalizeResponse(state, conversationStore);
  } catch (err) {
    logger.error("Ask Grahamy graph failed", {
      userId: state.internalUserId,
      conversationId: state.conversationId,
      messageId: state.messageId,
      error: err instanceof Error ? err.message : String(err),
    });
    state.answer = buildSafeErrorAnswer();
    state.classification = state.classification ?? EMPTY_CLASSIFICATION;
    state.publicResearchView = state.publicResearchView ?? EMPTY_PUBLIC_RESEARCH_VIEW;
    state.ui = state.ui ?? { cards: [], tables: [], suggestedFollowups: [] };
    state.meta = buildMeta(state.selectedTools ?? [], state.snapshots ?? {}, [
      ...state.warnings,
      "Ask Grahamy failed before a safe answer could be completed.",
    ], state.classification);
    return await finalizeResponse(state, conversationStore, "error");
  }
}

async function loadConversationContext(
  state: AskGrahamyState,
  conversationStore: AskGrahamyConversationStore,
): Promise<void> {
  state.conversationId = state.conversationId || crypto.randomUUID();
  state.messageId = crypto.randomUUID();
  state.previousContext = await conversationStore.load(state.conversationId, state.internalUserId);
}

async function classifyIntent(
  state: AskGrahamyState,
  classifier?: ClassifyOptions["classifier"],
): Promise<void> {
  state.classification = await classifyMessage(
    state.message,
    state.previousContext,
    { classifier },
  );
  state.warnings.push(...state.classification.warnings);
}

async function fetchBaseSnapshots(
  state: AskGrahamyState,
  snapshotClient: GrahamySnapshotClient,
): Promise<void> {
  state.snapshots = await snapshotClient.fetchPublishedSnapshots();
  if (state.snapshots.freshness?.staleReason) {
    state.warnings.push(state.snapshots.freshness.staleReason);
  }
}

function selectTools(state: AskGrahamyState): void {
  state.selectedTools = state.classification?.requiresTools ?? [];
}

async function executeTools(state: AskGrahamyState): Promise<void> {
  state.toolOutputs = await executeSnapshotTools(
    state.selectedTools ?? [],
    state.snapshots ?? {},
    state.classification ?? EMPTY_CLASSIFICATION,
  );
}

async function loadResearchObjects(state: AskGrahamyState): Promise<void> {
  const result = await buildResearchObjects({
    classification: state.classification ?? EMPTY_CLASSIFICATION,
    snapshots: state.snapshots ?? {},
    toolOutputs: state.toolOutputs ?? {},
    priorResearchObjects: state.priorResearchObjects ?? [],
  });
  state.researchObjects = result.objects;
  state.researchObjectsUpdated = result.objectsUpdated;
  state.researchObjectCacheStats = result.stats;
  state.warnings.push(...result.warnings);
}

function compileAnswerObject(state: AskGrahamyState): void {
  const classification = state.classification ?? EMPTY_CLASSIFICATION;
  const snapshots = state.snapshots ?? {};
  state.publicResearchView = compilePublicResearchView({
    classification,
    previousContext: state.previousContext,
    snapshots,
    toolOutputs: state.toolOutputs ?? {},
    researchObjects: state.researchObjects ?? [],
    warnings: state.warnings,
  });
  const generated = generateAnswerObject(classification, state.publicResearchView);
  state.answer = generated.answer;
  state.ui = generated.ui;
  state.meta = buildMeta(
    state.selectedTools ?? [],
    snapshots,
    state.warnings,
    classification,
    state.researchObjects ?? [],
    state.researchObjectCacheStats,
    state.researchObjectsUpdated ?? [],
  );
}

async function finalizeResponse(
  state: AskGrahamyState,
  conversationStore: AskGrahamyConversationStore,
  overrideAnswerType?: AskGrahamyResponse["answerType"],
): Promise<AskGrahamyResponse> {
  const classification = state.classification ?? EMPTY_CLASSIFICATION;
  const meta = state.meta ?? buildMeta(
    state.selectedTools ?? [],
    state.snapshots ?? {},
    state.warnings,
    classification,
    state.researchObjects ?? [],
    state.researchObjectCacheStats,
    state.researchObjectsUpdated ?? [],
  );
  const response: AskGrahamyResponse = {
    conversationId: state.conversationId ?? crypto.randomUUID(),
    messageId: state.messageId ?? crypto.randomUUID(),
    answerType: overrideAnswerType ?? inferAnswerType(classification),
    classification,
    answer: state.answer ?? buildSafeErrorAnswer(),
    research: {
      publicResearchView: state.publicResearchView ?? EMPTY_PUBLIC_RESEARCH_VIEW,
    },
    ui: state.ui ?? { cards: [], tables: [], suggestedFollowups: [] },
    meta,
  };

  const guard = runMoatGuard(response);
  guard.value.meta.warnings = Array.from(new Set([...guard.value.meta.warnings, ...guard.warnings]));
  guard.value.meta.moatGuardResult = guard.result;

  const publicResearchView = guard.value.research.publicResearchView;
  await conversationStore.persistTurn({
    conversationId: guard.value.conversationId,
    userId: state.internalUserId,
    classification: guard.value.classification,
    publicResearchView: isPublicResearchView(publicResearchView) ? publicResearchView : undefined,
    ui: guard.value.ui,
  });

  logger.info("Ask Grahamy turn completed", {
    userId: state.internalUserId,
    conversationId: guard.value.conversationId,
    messageId: guard.value.messageId,
    intent: guard.value.classification.intent,
    symbols: guard.value.classification.symbols,
    sectors: guard.value.classification.sectors,
    toolsUsed: guard.value.meta.toolsUsed,
    snapshotFreshness: guard.value.meta.freshness,
    upstreamLatency: guard.value.meta.upstreamLatency,
    warnings: guard.value.meta.warnings,
    moatGuardResult: guard.value.meta.moatGuardResult,
  });

  return guard.value;
}

function buildMeta(
  toolsUsed: ToolName[],
  snapshots: SnapshotBundle,
  warnings: string[],
  classification: Classification,
  researchObjects: import("./types").CachedResearchObject[] = [],
  researchObjectCacheStats?: import("./types").ResponseMeta["researchObjectCache"],
  researchObjectsUpdated: import("./types").CachedResearchObject[] = [],
): ResponseMeta {
  const sourcesUsed = ["daily_brief", "metadata", "clusters", "track_record", "transparency"]
    .filter((name) => !!snapshots[name as keyof SnapshotBundle])
    .map((name) => ({ type: "snapshot" as const, name }));
  const researchSources = researchObjects.map((item) => ({
    type: "research" as const,
    name: item.cacheKey,
  }));
  return {
    sourcesUsed: [...sourcesUsed, ...researchSources],
    freshness: snapshots.freshness ?? {},
    warnings: Array.from(new Set([...warnings, ...classification.warnings, ...Object.values(snapshots.errors ?? {})])),
    toolsUsed,
    researchObjectKeys: researchObjects.map((item) => item.cacheKey),
    researchObjectCache: researchObjectCacheStats,
    researchObjectsUpdated: researchObjectsUpdated.length ? researchObjectsUpdated : undefined,
    upstreamLatency: snapshots.latencyMs,
  };
}

function inferAnswerType(classification: Classification): AskGrahamyResponse["answerType"] {
  if (classification.intent === "unknown") return "unknown";
  const stock = classification.symbols.length > 0;
  const sector = classification.sectors.length > 0;
  const regime = classification.regimeRequested;
  if (stock && !sector && !regime) return "stock";
  if (sector && !stock && !regime) return "sector";
  if (regime && !stock && !sector) return "regime";
  return "mixed";
}

function isPublicResearchView(value: unknown): value is import("./types").PublicResearchView {
  return !!value && typeof value === "object" && "objectType" in value;
}
