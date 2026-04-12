import { StateGraph, START, END } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { AgentAnnotation, AgentState } from "../../state";
import { summarizationGuardNode } from "../shared_nodes/summarizationGuard";
import { sessionSummarizationNode } from "../shared_nodes/sessionSummarization";
import { roundtableContextBuilderNode } from "./nodes/roundtableContextBuilder";
import { roundtableCallModelNode } from "./nodes/roundtableCallModel";

// ─── Routing helpers ─────────────────────────────────────────────────────────

function routeAfterGuard(state: AgentState): string {
  if (state.needsSummarization) return "sessionSummarization";
  return "assembleRoundtableContext";
}

// ─── Graph definition ────────────────────────────────────────────────────────
//
//  START → summarizationGuard
//            ├── (thresholds exceeded) → sessionSummarization → assembleRoundtableContext → roundtableCallModel → END
//            └── (normal)              → assembleRoundtableContext → roundtableCallModel → END
//

const workflow = new StateGraph(AgentAnnotation)
  .addNode("summarizationGuard", summarizationGuardNode)
  .addNode("sessionSummarization", sessionSummarizationNode)
  .addNode("assembleRoundtableContext", roundtableContextBuilderNode)
  .addNode("roundtableCallModel", roundtableCallModelNode)

  .addEdge(START, "summarizationGuard")

  .addConditionalEdges("summarizationGuard", routeAfterGuard, {
    sessionSummarization: "sessionSummarization",
    assembleRoundtableContext: "assembleRoundtableContext",
  })

  .addEdge("sessionSummarization", "assembleRoundtableContext")
  .addEdge("assembleRoundtableContext", "roundtableCallModel")
  .addEdge("roundtableCallModel", END);

/**
 * Compiles the roundtable graph with a Postgres checkpointer.
 * Call once at startup alongside the basic and epic graphs.
 */
export async function createRoundtableGraph() {
  const connectionString =
    process.env.DATABASE_URL ??
    `postgres://${process.env.PGUSER ?? "scheduler"}:${process.env.PGPASSWORD ?? "scheduler_pass"}@${process.env.PGHOST ?? "localhost"}:${process.env.PGPORT ?? "5432"}/${process.env.PGDATABASE ?? "scheduler_agent"}`;

  const checkpointer = PostgresSaver.fromConnString(connectionString);
  await checkpointer.setup();

  return workflow.compile({ checkpointer });
}

export { workflow as roundtableWorkflow };
