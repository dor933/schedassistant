import crypto from "node:crypto";
import { logger } from "../logger";
import { classifyMessage, type ClassifyOptions } from "./classification";
import {
  buildSafeErrorAnswer,
  buildUnknownAnswer,
  DEFAULT_FOLLOWUPS,
} from "./answerTemplates";
import { runMoatGuard } from "./moatGuard";
import { compilePublicResearchView } from "./publicResearch";
import { buildResearchObjects } from "./researchObjectBuilder";
import { GrahamySnapshotClient } from "./snapshotClient";
import { executeSnapshotTools } from "./tools";
import { runGrahamyDeepAgent } from "./grahamyAgent";
import {
  DEFAULT_DISCLAIMER,
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
  // Test seam — lets graph.test.ts run without a live LLM. Production code
  // leaves this undefined so classification falls back to the model-backed
  // classifier configured in classification.ts.
  classifier?: ClassifyOptions["classifier"];
};

/**
 * askGrahamy graph — runs once per StocksScanner turn.
 *
 *   classify (skip if SS already supplied) → fetch base snapshots →
 *   execute snapshot tools → load research objects (priors + SQL miss) →
 *   compile publicResearchView (UI surface) → invoke Grahamy deep agent
 *   (PostgresSaver memory keyed on conversationId) → moat guard → return.
 *
 * Conversation memory lives in PostgresSaver via `thread_id = conversationId`,
 * NOT in a separate JSON conversation store. Follow-up resolution happens
 * naturally inside the agent — no per-classifier follow-up branch needed.
 */
export async function runAskGrahamyGraph(
  request: AskGrahamyRequest,
  internalUserId: number,
  options: RunAskGrahamyGraphOptions = {},
): Promise<AskGrahamyResponse> {
  // Caller (StocksScanner) may have already classified + pre-loaded its
  // local research objects via POST /api/ask-grahamy/classify. When supplied
  // we skip the LLM classify call and treat the prior objects as cache hits.
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

  // Ensure we have a conversationId — the deep agent uses it as PostgresSaver
  // thread_id. SS normally supplies one (per chat in its UI); we generate
  // a UUID only as a fallback for direct callers.
  state.conversationId = state.conversationId || crypto.randomUUID();
  state.messageId = crypto.randomUUID();

  const snapshotClient = options.snapshotClient ?? new GrahamySnapshotClient();

  try {
    if (!state.classification) {
      await classifyIntent(state, options.classifier);
    }

    // Static stub for "I don't understand the question" — skip the deep
    // agent entirely so we don't hallucinate without anchors.
    if (state.classification?.intent === "unknown") {
      const unknown = buildUnknownAnswer();
      state.answer = unknown.answer;
      state.publicResearchView = unknown.researchView;
      state.ui = unknown.ui;
      state.meta = buildMeta([], {}, state.warnings, state.classification);
      return await finalizeResponse(state, unknown.answerType);
    }

    await fetchBaseSnapshots(state, snapshotClient);
    selectTools(state);
    await executeTools(state);
    await loadResearchObjects(state);

    // publicResearchView is built for response.research / UI consumption.
    // The deep agent reads its evidence from state.researchObjects directly,
    // not from this view, so this is purely for the response payload shape.
    state.publicResearchView = compilePublicResearchView({
      classification: state.classification ?? EMPTY_CLASSIFICATION,
      previousContext: undefined,
      snapshots: state.snapshots ?? {},
      toolOutputs: state.toolOutputs ?? {},
      researchObjects: state.researchObjects ?? [],
      warnings: state.warnings,
    });

    // Hand off to the deep agent. It composes the actual user-facing answer
    // by reading state.researchObjects + state.message + its PostgresSaver
    // thread history (prior turns in this conversation).
    const grahamy = await runGrahamyDeepAgent(state);
    state.warnings.push(...grahamy.warnings);

    state.answer = {
      headline: "",
      summary: grahamy.answerText,
      bullets: [],
      watchpoints: [],
      disclaimer: DEFAULT_DISCLAIMER,
    };
    state.ui = {
      cards: [],
      tables: [],
      suggestedFollowups: DEFAULT_FOLLOWUPS,
    };
    state.meta = buildMeta(
      state.selectedTools ?? [],
      state.snapshots ?? {},
      state.warnings,
      state.classification ?? EMPTY_CLASSIFICATION,
      state.researchObjects ?? [],
      state.researchObjectCacheStats,
      state.researchObjectsUpdated ?? [],
    );

    return await finalizeResponse(state);
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
    state.meta = buildMeta(
      state.selectedTools ?? [],
      state.snapshots ?? {},
      [
        ...state.warnings,
        "Ask Grahamy failed before a safe answer could be completed.",
      ],
      state.classification,
    );
    return await finalizeResponse(state, "error");
  }
}

async function classifyIntent(
  state: AskGrahamyState,
  classifier?: ClassifyOptions["classifier"],
): Promise<void> {
  state.classification = await classifyMessage(state.message, undefined, {
    classifier,
  });
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

async function finalizeResponse(
  state: AskGrahamyState,
  overrideAnswerType?: AskGrahamyResponse["answerType"],
): Promise<AskGrahamyResponse> {
  const classification = state.classification ?? EMPTY_CLASSIFICATION;
  const meta =
    state.meta ??
    buildMeta(
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
  guard.value.meta.warnings = Array.from(
    new Set([...guard.value.meta.warnings, ...guard.warnings]),
  );
  guard.value.meta.moatGuardResult = guard.result;

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
    warnings: Array.from(
      new Set([
        ...warnings,
        ...classification.warnings,
        ...Object.values(snapshots.errors ?? {}),
      ]),
    ),
    toolsUsed,
    researchObjectKeys: researchObjects.map((item) => item.cacheKey),
    researchObjectCache: researchObjectCacheStats,
    researchObjectsUpdated: researchObjectsUpdated.length
      ? researchObjectsUpdated
      : undefined,
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
