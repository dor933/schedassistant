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
  researchPlannerNode,
  requireClassificationNode,
  safeErrorResponseNode,
  selectToolsNode,
} from "./nodes";
import type {
  CachedCapabilityView,
} from "./pgCapabilities/types";
import type {
  AskGrahamyRequest,
  AskGrahamyResponse,
  AskGrahamyState,
  CachedResearchObject,
} from "./types";

export type { RunAskGrahamyGraphOptions };

function routeAfterNode(state: AskGrahamyLangGraphState): "next" | "error" {
  return state.error ? "error" : "next";
}

function routeAfterResearchPlanner(
  state: AskGrahamyLangGraphState,
): "plannerHandled" | "standardLoaders" | "error" {
  if (state.error) return "error";
  return state.plannerHandled ? "plannerHandled" : "standardLoaders";
}

const askGrahamyWorkflow = new StateGraph(AskGrahamyGraphAnnotation)
  .addNode("requireClassification", requireClassificationNode)
  .addNode("fetchBaseSnapshots", fetchBaseSnapshotsNode)
  .addNode("selectTools", selectToolsNode)
  .addNode("executeTools", executeToolsNode)
  .addNode("researchPlanner", researchPlannerNode)
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
    next: "researchPlanner",
    error: "safeErrorResponse",
  })
  .addConditionalEdges("researchPlanner", routeAfterResearchPlanner, {
    plannerHandled: "compileEvidence",
    standardLoaders: "loadResearchObjects",
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
 * askGrahamy graph — runs once per StocksScanner turn.
 *
 *   require supplied classification -> fetch base snapshots ->
 *   execute snapshot tools -> research planner ->
 *     planner handled: compile evidence -> synthesize answer -> moat guard
 *     standard path: load research objects/capabilities/overlays ->
 *       compile evidence -> invoke Grahamy deep agent -> moat guard.
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
  // Caller (StocksScanner) must classify via POST /api/ask-grahamy/classify,
  // then send that classification here with any cache hits it found locally.
  const suppliedPriorObjects =
    (request as { priorResearchObjects?: CachedResearchObject[] }).priorResearchObjects;
  const suppliedPriorCapabilityViews =
    (request as { priorCapabilityViews?: CachedCapabilityView[] })
      .priorCapabilityViews;

  const state: AskGrahamyState = {
    internalUserId,
    conversationId: request.conversationId ?? undefined,
    message: request.message,
    warnings: [],
    classification: request.classification,
    priorResearchObjects: suppliedPriorObjects,
    priorCapabilityViews: suppliedPriorCapabilityViews,
  };

  // Ensure we have a conversationId — the deep agent uses it as PostgresSaver
  // thread_id. SS normally supplies one (per chat in its UI); we generate
  // a UUID only as a fallback for direct callers.
  state.conversationId = state.conversationId || crypto.randomUUID();
  state.messageId = crypto.randomUUID();

  const snapshotClient = options.snapshotClient ?? new GrahamySnapshotClient();
  const graphState: AskGrahamyGraphState = {
    ...state,
    options,
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
