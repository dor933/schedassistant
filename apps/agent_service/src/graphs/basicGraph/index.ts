import { StateGraph, START, END } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { AgentAnnotation, AgentState } from "../../state";
import { summarizationGuardNode } from "../shared_nodes/summarizationGuard";
import { sessionSummarizationNode } from "../shared_nodes/sessionSummarization";
import { contextBuilderNode } from "./nodes/contextBuilder";
import { callModelNode } from "./nodes/callModel";

// ─── Routing helpers ─────────────────────────────────────────────────────────

function routeAfterGuard(state: AgentState): string {
  if (state.needsSummarization) return "sessionSummarization";
  return "assembleContext";
}

// ─── Graph definition ────────────────────────────────────────────────────────
//
//  START → summarizationGuard
//            ├── (thresholds exceeded) → sessionSummarization → assembleContext → callModel → END
//            └── (normal)              → assembleContext → callModel → END
//

const workflow = new StateGraph(AgentAnnotation)
  .addNode("summarizationGuard", summarizationGuardNode)
  .addNode("sessionSummarization", sessionSummarizationNode)
  .addNode("assembleContext", contextBuilderNode)
  .addNode("callModel", callModelNode)

  .addEdge(START, "summarizationGuard")

  .addConditionalEdges("summarizationGuard", routeAfterGuard, {
    sessionSummarization: "sessionSummarization",
    assembleContext: "assembleContext",
  })

  .addEdge("sessionSummarization", "assembleContext")
  .addEdge("assembleContext", "callModel")
  .addEdge("callModel", END);

/**
 * Creates the Postgres checkpointer, runs its setup (creates checkpoint
 * tables if they don't exist), and compiles the graph with persistence.
 *
 * Call once at startup; the returned graph can then be invoked per request
 * with `configurable.thread_id` to load/save per-conversation state.
 */
export async function createSchedulerGraph() {
  const connectionString =
    process.env.DATABASE_URL ??
    `postgres://${process.env.PGUSER ?? "scheduler"}:${process.env.PGPASSWORD ?? "scheduler_pass"}@${process.env.PGHOST ?? "localhost"}:${process.env.PGPORT ?? "5432"}/${process.env.PGDATABASE ?? "scheduler_agent"}`;

  const checkpointer = PostgresSaver.fromConnString(connectionString);

  // Creates the library's checkpoint tables if they don't already exist.
  await checkpointer.setup();

  const graph = workflow.compile({ checkpointer });

  return graph;
}

/** Re-export the raw workflow for unit tests that don't need persistence. */
export { workflow };
