import crypto from "node:crypto";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getLangfuseCallbackHandler, observeWithContext } from "../../langfuse";
import { GrahamySnapshotClient } from "../snapshots/snapshotClient";
import {
  AskGrahamyGraphAnnotation,
  toAskGrahamyState,
  type AskGrahamyGraphState,
  type AskGrahamyLangGraphState,
  type RunAskGrahamyGraphOptions,
} from "../state/askGrahamyState";
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
} from "../nodes";
import type {
  AskGrahamyLandingWarmRequest,
  AskGrahamyResponse,
  AskGrahamyState,
} from "../types";

function routeAfterNode(state: AskGrahamyLangGraphState): "next" | "error" {
  return state.error ? "error" : "next";
}

function routeAfterResearchPlanner(
  state: AskGrahamyLangGraphState,
): "plannerHandled" | "standardLoaders" | "error" {
  if (state.error) return "error";
  return state.plannerHandled ? "plannerHandled" : "standardLoaders";
}

/**
 * Worker-only graph for nightly landing/ranking warmups.
 *
 * This graph is allowed to run the expensive PG capabilities, planner
 * workflows, and Research Object fanout. The live chat graph in `askQuestion.ts`
 * is intentionally separate and cache-read-only for capability/ranking
 * views.
 */
const askGrahamyLandingWarmWorkflow = new StateGraph(AskGrahamyGraphAnnotation)
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

const compiledAskGrahamyLandingWarmWorkflow =
  askGrahamyLandingWarmWorkflow.compile();

export { askGrahamyLandingWarmWorkflow };

export async function runAskGrahamyLandingWarmGraph(
  request: AskGrahamyLandingWarmRequest,
  internalUserId: number,
  options: RunAskGrahamyGraphOptions = {},
): Promise<AskGrahamyResponse> {
  const suppliedAsOfDate =
    (request as { asOfDate?: string }).asOfDate?.trim() || undefined;

  const state: AskGrahamyState = {
    internalUserId,
    conversationId: request.conversationId ?? undefined,
    message: request.message,
    warnings: [],
    classification: request.classification,
    priorResearchObjects:
      (request as { priorResearchObjects?: AskGrahamyState["priorResearchObjects"] })
        .priorResearchObjects ?? [],
    priorCapabilityViews:
      (request as { priorCapabilityViews?: AskGrahamyState["priorCapabilityViews"] })
        .priorCapabilityViews ?? [],
    ...(suppliedAsOfDate ? { asOfDate: suppliedAsOfDate } : {}),
  };

  state.conversationId = state.conversationId || crypto.randomUUID();
  state.messageId = crypto.randomUUID();

  const graphOptions: RunAskGrahamyGraphOptions = {
    ...options,
    executionMode: "landing_warm",
  };
  const snapshotClient = graphOptions.snapshotClient ?? new GrahamySnapshotClient();
  const graphState: AskGrahamyGraphState = {
    ...state,
    options: graphOptions,
    snapshotClient,
    plannerHandled: false,
  };

  return observeWithContext(
    "ask_grahamy_landing_warm_turn",
    async () => {
      const handler = getLangfuseCallbackHandler(internalUserId, {
        service: "ask_grahamy_landing_warm",
        conversationId: state.conversationId ?? null,
        messageId: state.messageId ?? null,
      });

      try {
        const finalState = await compiledAskGrahamyLandingWarmWorkflow.invoke(
          graphState,
          (handler
            ? { callbacks: [handler] as RunnableConfig["callbacks"] }
            : undefined) as RunnableConfig | undefined,
        );
        if (finalState.response) return finalState.response;
        const missingResponseError = finalState.error
          ? new Error(finalState.error)
          : new Error("Ask Grahamy landing warm graph completed without a response.");
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
