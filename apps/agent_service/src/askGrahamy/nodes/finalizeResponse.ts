import crypto from "node:crypto";
import { logger } from "../../logger";
import { buildSafeErrorAnswer } from "../answerTemplates";
import { runMoatGuard } from "../moatGuard";
import {
  EMPTY_CLASSIFICATION,
  EMPTY_PUBLIC_RESEARCH_VIEW,
  type AskGrahamyResponse,
  type AskGrahamyState,
  type Classification,
} from "../types";
import { buildMeta } from "./buildMeta";
import {
  type AskGrahamyGraphState,
  type AskGrahamyLangGraphState,
  errorMessage,
  patchFromAskGrahamyState,
  runGraphNode,
  toAskGrahamyState,
} from "../askGrahamyState";

export async function finalizeResponseNode(
  state: AskGrahamyLangGraphState,
): Promise<Partial<AskGrahamyGraphState>> {
  return runGraphNode(state, async () => {
    const next = toAskGrahamyState(state);
    const response = await finalizeResponse(next);
    return {
      ...patchFromAskGrahamyState(next),
      response,
    };
  });
}

export async function finalizeResponse(
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
      state.pgCapabilityViews,
      state.capabilityViewsUpdated ?? [],
      state.capabilityViewCacheStats,
      state.pipelineOverlayViews,
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

export async function finalizeSafeGraphError(
  state: AskGrahamyState,
  err: unknown,
): Promise<AskGrahamyResponse> {
  logger.error("Ask Grahamy graph failed", {
    userId: state.internalUserId,
    conversationId: state.conversationId,
    messageId: state.messageId,
    error: errorMessage(err),
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

function inferAnswerType(
  classification: Classification,
): AskGrahamyResponse["answerType"] {
  if (classification.intent === "platform_help") return "help";
  if (classification.intent === "unknown") return "unknown";
  if (classification.intent === "sector_conviction_leaderboard") return "sector";
  if (classification.intent === "sector_momentum_vs_conviction_divergence") return "sector";
  if (classification.intent === "week_over_week_sector_delta") return "sector";
  if (classification.intent === "stock_idea_discovery") return "stock";
  if (classification.intent === "sector_leaders") return "stock";
  if (classification.intent === "feature_screen") return "stock";
  if (classification.intent === "factor_conditioned_backtest") return "stock";
  if (classification.intent === "market_regime_historical_playbook") return "regime";
  const stock = classification.symbols.length > 0;
  const sector = classification.sectors.length > 0;
  const regime = classification.regimeRequested;
  if (stock && !sector && !regime) return "stock";
  if (sector && !stock && !regime) return "sector";
  if (regime && !stock && !sector) return "regime";
  return "mixed";
}
