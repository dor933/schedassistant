import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import { ApplicationAgentAnnotation } from "./state";
import { applicationContextBuilderNode } from "./nodes/applicationContextBuilder";
import { applicationCallModelNode } from "./nodes/applicationCallModel";

// ─── Graph definition ────────────────────────────────────────────────────────
//
//  START → applicationContextBuilder → applicationCallModel → END
//
// **Two-layer state model:**
//
//  - The OUTER graph (this file) is a one-shot per-invocation pipeline:
//    build the system prompt → run the inner deep agent → return its answer.
//    Its state (request, response, systemPrompt) is transient — there is no
//    benefit to persisting it across calls — so the outer checkpointer is
//    `MemorySaver`.
//
//  - The INNER deep agent (constructed inside `applicationCallModelNode`) is
//    where the actual conversation history lives. It uses a `PostgresSaver`
//    keyed to a stable thread id looked up from `application_agent_threads`
//    by `(user_id, application_agent_id)`. That is what gives the same
//    end-user continuity across REST invocations and primary-tool calls.
//

const workflow = new StateGraph(ApplicationAgentAnnotation)
  .addNode("applicationContextBuilder", applicationContextBuilderNode)
  .addNode("applicationCallModel", applicationCallModelNode)

  .addEdge(START, "applicationContextBuilder")
  .addEdge("applicationContextBuilder", "applicationCallModel")
  .addEdge("applicationCallModel", END);

export async function createApplicationGraph() {
  const checkpointer = new MemorySaver();
  return workflow.compile({ checkpointer });
}

export { workflow as applicationWorkflow };
