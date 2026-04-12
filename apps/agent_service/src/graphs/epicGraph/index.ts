import { StateGraph, START, END } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { AgentAnnotation, AgentState } from "../../state";
import { summarizationGuardNode } from "../shared_nodes/summarizationGuard";
import { sessionSummarizationNode } from "../shared_nodes/sessionSummarization";
import { epicContextBuilderNode } from "./nodes/epicContextBuilder";
import { epicCallModelNode } from "./nodes/callModel";

// ─── Routing helpers ─────────────────────────────────────────────────────────

function routeAfterGuard(state: AgentState): string {
  if (state.needsSummarization) return "sessionSummarization";
  return "assembleEpicContext";
}

// ─── Graph definition ────────────────────────────────────────────────────────
//
//  START → summarizationGuard
//            ├── (thresholds exceeded) → sessionSummarization → assembleEpicContext → epicCallModel → END
//            └── (normal)              → assembleEpicContext → epicCallModel → END
//
// Knowledge capture is now agent-curated via the `save_episodic_memory` tool
// invoked from inside `epicCallModel` — no dedicated post-turn sync node.
//

const workflow = new StateGraph(AgentAnnotation)
  .addNode("summarizationGuard", summarizationGuardNode)
  .addNode("sessionSummarization", sessionSummarizationNode)
  .addNode("assembleEpicContext", epicContextBuilderNode)
  .addNode("epicCallModel", epicCallModelNode)

  .addEdge(START, "summarizationGuard")

  .addConditionalEdges("summarizationGuard", routeAfterGuard, {
    sessionSummarization: "sessionSummarization",
    assembleEpicContext: "assembleEpicContext",
  })

  .addEdge("sessionSummarization", "assembleEpicContext")
  .addEdge("assembleEpicContext", "epicCallModel")
  .addEdge("epicCallModel", END);

/**
 * Creates the Epic Orchestrator graph with Postgres checkpointer.
 * Separate from the basic graph — only used for the epic orchestrator agent.
 */
export async function createEpicGraph() {
  const connectionString =
    process.env.DATABASE_URL ??
    `postgres://${process.env.PGUSER ?? "scheduler"}:${process.env.PGPASSWORD ?? "scheduler_pass"}@${process.env.PGHOST ?? "localhost"}:${process.env.PGPORT ?? "5432"}/${process.env.PGDATABASE ?? "scheduler_agent"}`;

  const checkpointer = PostgresSaver.fromConnString(connectionString);
  await checkpointer.setup();

  return workflow.compile({ checkpointer });
}

export { workflow as epicWorkflow };
