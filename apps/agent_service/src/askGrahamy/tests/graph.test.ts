import test from "node:test";

// TODO: rewrite this end-to-end test for the new deep-agent path.
//
// The previous incarnation exercised the templated `generateAnswerObject`
// renderer and used `AskGrahamyConversationStore` (a /tmp JSON file) as the
// conversation memory. Both have since been replaced:
//   - the answer is now produced by `runGrahamyDeepAgent` (LLM call),
//   - conversation memory lives in PostgresSaver via `thread_id`.
//
// A faithful test needs to either (a) stub `runGrahamyDeepAgent` via a new
// `RunAskGrahamyGraphOptions` test seam, or (b) run against a mock LLM +
// in-memory checkpointer. Neither is wired yet; the bare flow is exercised
// via the live `/api/ask-grahamy` endpoint in dev.

test.skip("runs the graph end to end over mocked snapshots", () => {});
