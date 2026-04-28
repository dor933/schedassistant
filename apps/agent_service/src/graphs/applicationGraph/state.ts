import { Annotation } from "@langchain/langgraph";
import type { AgentId, UserId } from "@scheduling-agent/types";

/**
 * State annotation for application agents.
 *
 * Application agents are REST-triggered, stateless request/response invocations
 * built on the `deepagents` library. We deliberately keep the state surface
 * minimal — no session summaries, no roundtable config, no per-thread workspace
 * — because each invocation is one-shot and ephemeral (MemorySaver checkpointer).
 *
 * If durable conversation history is needed later, swap MemorySaver for
 * PostgresSaver in `index.ts` and add a `threadId` field that the caller
 * supplies on each request.
 */
export const ApplicationAgentAnnotation = Annotation.Root({
  /** The application agent serving this request (`agents.id`, type='application'). */
  agentId: Annotation<AgentId>({
    reducer: (state, update) => (update !== undefined ? update : state),
    default: () => "",
  }),

  /**
   * The internal `users.id` representing the end user this invocation acts
   * on behalf of. For REST calls this is JIT-resolved by the controller from
   * the supplied `externalUserId`; for primary-tool delegations the calling
   * primary's `state.userId` flows through directly. Required — the call
   * model defends against missing values.
   */
  userId: Annotation<UserId | null>({
    reducer: (state, update) => (update !== undefined ? update : state),
    default: () => null,
  }),

  /**
   * Stable LangGraph thread id for the inner deep agent, looked up from
   * `application_agent_threads` by `(userId, agentId)` before invocation.
   * Used as `configurable.thread_id` when invoking the deep agent so its
   * PostgresSaver checkpoint resumes the right conversation.
   */
  applicationThreadId: Annotation<string | null>({
    reducer: (state, update) => (update !== undefined ? update : state),
    default: () => null,
  }),

  /** Raw input string from the REST caller (POST body `input`). */
  request: Annotation<string>({
    reducer: (_state, update) => update,
    default: () => "",
  }),

  /** Final assistant text returned to the REST caller. */
  response: Annotation<string>({
    reducer: (_state, update) => update,
    default: () => "",
  }),

  /** System prompt assembled by the context builder for this invocation. */
  systemPrompt: Annotation<string>({
    reducer: (_state, update) => update,
    default: () => "",
  }),

  /** Error propagation channel (null = no error). */
  error: Annotation<string | null>({
    reducer: (_state, update) => update,
    default: () => null,
  }),
});

export type ApplicationAgentState = typeof ApplicationAgentAnnotation.State;
