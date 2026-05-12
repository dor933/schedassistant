import crypto from "node:crypto";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getLangfuseCallbackHandler, observeWithContext } from "../langfuse";
import { GrahamySnapshotClient } from "./snapshotClient";
import {
  AskGrahamyGraphAnnotation,
  toAskGrahamyState,
  type AskGrahamyGraphState,
  type AskGrahamyLangGraphState,
  type RunAskGrahamyGraphOptions,
} from "./askGrahamyState";
import {
  loadCachedCapabilityViewsByIds,
  loadCachedResearchObjectsByIds,
} from "./cacheRepository";
import {
  answerNode,
  buildMetaNode,
  compileEvidenceNode,
  executeToolsNode,
  fetchBaseSnapshotsNode,
  finalizeResponseNode,
  finalizeSafeGraphError,
  loadPgCapabilitiesNode,
  loadPipelineOverlaysNode,
  loadResearchObjectsNode,
  requireClassificationNode,
  safeErrorResponseNode,
  selectToolsNode,
} from "./nodes";
import type {
  AskGrahamyRequest,
  AskGrahamyResponse,
  AskGrahamyState,
} from "./types";

export type { RunAskGrahamyGraphOptions };

function routeAfterNode(state: AskGrahamyLangGraphState): "next" | "error" {
  return state.error ? "error" : "next";
}

const askGrahamyWorkflow = new StateGraph(AskGrahamyGraphAnnotation)
  .addNode("requireClassification", requireClassificationNode)
  .addNode("fetchBaseSnapshots", fetchBaseSnapshotsNode)
  .addNode("selectTools", selectToolsNode)
  .addNode("executeTools", executeToolsNode)
  .addNode("loadResearchObjects", loadResearchObjectsNode)
  .addNode("loadPgCapabilities", loadPgCapabilitiesNode)
  .addNode("loadPipelineOverlays", loadPipelineOverlaysNode)
  .addNode("compileEvidence", compileEvidenceNode)
  .addNode("buildAnswer", answerNode)
  .addNode("buildMeta", buildMetaNode)
  .addNode("finalizeResponse", finalizeResponseNode)
  .addNode("safeErrorResponse", safeErrorResponseNode)

  .addEdge(START, "requireClassification")
  .addConditionalEdges("requireClassification", routeAfterNode, {
    next: "fetchBaseSnapshots",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("fetchBaseSnapshots", routeAfterNode, {
    next: "selectTools",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("selectTools", routeAfterNode, {
    next: "executeTools",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("executeTools", routeAfterNode, {
    next: "loadResearchObjects",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("loadResearchObjects", routeAfterNode, {
    next: "loadPgCapabilities",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("loadPgCapabilities", routeAfterNode, {
    next: "loadPipelineOverlays",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("loadPipelineOverlays", routeAfterNode, {
    next: "compileEvidence",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("compileEvidence", routeAfterNode, {
    next: "buildAnswer",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("buildAnswer", routeAfterNode, {
    next: "buildMeta",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("buildMeta", routeAfterNode, {
    next: "finalizeResponse",
    error: "safeErrorResponse",
  })
  .addEdge("finalizeResponse", END)
  .addEdge("safeErrorResponse", END);

const compiledAskGrahamyWorkflow = askGrahamyWorkflow.compile();

export { askGrahamyWorkflow };

/**
 * Live askGrahamy chat graph — runs once per StocksScanner user turn.
 *
 *   require supplied classification -> fetch base snapshots ->
 *   execute snapshot tools -> load direct stock ROs/cached capability views ->
 *   compile evidence -> invoke Grahamy deep agent -> moat guard.
 *
 * This graph is intentionally not the nightly warm graph. It does not contain
 * the planner branch and `loadPgCapabilities` is cache-read-only in live mode.
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
  // Live caller must classify via POST /api/ask-grahamy/classify, then send
  // cache row ids only. Full cached JSONB payloads are accepted only by the
  // separate landing warm graph.
  const suppliedPriorObjectIds =
    (request as { priorResearchObjectIds?: string[] }).priorResearchObjectIds;
  const suppliedPriorCapabilityViewIds =
    (request as { priorCapabilityViewIds?: string[] }).priorCapabilityViewIds;
  const suppliedAsOfDate =
    (request as { asOfDate?: string }).asOfDate?.trim() || undefined;

  const hydratedPriorObjects =
    await loadCachedResearchObjectsByIds(suppliedPriorObjectIds);
  const hydratedPriorCapabilityViews =
    await loadCachedCapabilityViewsByIds(suppliedPriorCapabilityViewIds);

  const state: AskGrahamyState = {
    internalUserId,
    conversationId: request.conversationId ?? undefined,
    message: request.message,
    warnings: [],
    classification: request.classification,
    priorResearchObjects: hydratedPriorObjects,
    priorResearchObjectIds: suppliedPriorObjectIds,
    priorCapabilityViews: hydratedPriorCapabilityViews,
    priorCapabilityViewIds: suppliedPriorCapabilityViewIds,
    ...(suppliedAsOfDate ? { asOfDate: suppliedAsOfDate } : {}),
  };

  // Ensure we have a conversationId — the deep agent uses it as PostgresSaver
  // thread_id. SS normally supplies one (per chat in its UI); we generate
  // a UUID only as a fallback for direct callers.
  state.conversationId = state.conversationId || crypto.randomUUID();
  state.messageId = crypto.randomUUID();

  const snapshotClient = options.snapshotClient ?? new GrahamySnapshotClient();
  const graphOptions: RunAskGrahamyGraphOptions = {
    ...options,
    executionMode: "live",
  };
  const graphState: AskGrahamyGraphState = {
    ...state,
    options: graphOptions,
    snapshotClient,
    plannerHandled: false,
  };

  // Top-level Langfuse observation for the whole askGrahamy turn — mirrors
  // `agent_chat_turn` from executeChatTurn.ts. Attaches a LangChain callback
  // handler to the graph invoke so each LangGraph node, plus any nested LLM
  // calls (planner, brief synthesizer, grahamy deep agent)
  // emit child generation/chain spans automatically.
  return observeWithContext(
    "ask_grahamy_turn",
    async () => {
      const handler = getLangfuseCallbackHandler(internalUserId, {
        service: "ask_grahamy",
        conversationId: state.conversationId ?? null,
        messageId: state.messageId ?? null,
      });

      try {
        const finalState = await compiledAskGrahamyWorkflow.invoke(
          graphState,
          (handler
            ? { callbacks: [handler] as RunnableConfig["callbacks"] }
            : undefined) as RunnableConfig | undefined,
        );
        if (finalState.response) return finalState.response;
        const missingResponseError = finalState.error
          ? new Error(finalState.error)
          : new Error("Ask Grahamy graph completed without a response.");
        return await finalizeSafeGraphError(
          toAskGrahamyState(finalState),
          missingResponseError,
        );
      } catch (err) {
        return await finalizeSafeGraphError(state, err);
      }
    },
    {
      userId: internalUserId,
      conversationId: state.conversationId,
      messagePreview:
        typeof request.message === "string"
          ? request.message.slice(0, 500)
          : "",
    },
  );
}
