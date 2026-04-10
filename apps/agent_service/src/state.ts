import { Annotation } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import { AgentId } from "@scheduling-agent/types";

/**
 * LangGraph state annotation for conversational agents (any specialization).
 *
 * `userId` is set once when the thread is created (by the user-facing
 * application layer) and carried through every node so that memory
 * retrieval, core-file I/O, and session isolation can always scope to
 * the correct user without re-resolving identity.
 */
export const AgentAnnotation = Annotation.Root({
  /** The user who owns this conversation thread (`users.id`). */
  userId: Annotation<number>,

  /** The LangGraph thread_id for this conversation (mirrors configurable.thread_id). */
  threadId: Annotation<string>,

  /** When set, session summaries and registry rows are scoped to this group (`groups.id`). */
  groupId: Annotation<string | null>({
    reducer: (state, update) => (update !== undefined ? update : state),
    default: () => null,
  }),

  /** When set, session summaries and registry rows are scoped to this 1:1 chat (`single_chats.id`). */
  singleChatId: Annotation<string | null>({
    reducer: (state, update) => (update !== undefined ? update : state),
    default: () => null,
  }),

  /**
   * Which logical agent serves this thread (`agents.id`). Used to load
   * `agents.core_instructions` from the DB into the system prompt each turn.
   */
  agentId: Annotation<AgentId>({
    reducer: (state, update) => (update !== undefined ? update : state),
    default: () => "",
  }),

  /** Model slug resolved from the conversation's model_id (e.g. "gpt-4o", "claude-opus-4-6"). */
  modelSlug: Annotation<string>({
    reducer: (state, update) => (update !== undefined ? update : state),
    default: () => "gpt-4o",
  }),

  /** Conversation messages managed by the checkpointer. */
  messages: Annotation<BaseMessage[]>({
    reducer: (state, update) => [...state, ...update],
    default: () => [],
  }),

  /** Assembled system prompt injected each turn (from contextBuilder). */
  systemPrompt: Annotation<string>({
    reducer: (_state, update) => update,
    default: () => "",
  }),

  /** Latest user input text (convenience — also in messages). */
  userInput: Annotation<string>({
    reducer: (_state, update) => update,
    default: () => "",
  }),

  /** Whether this turn's context has already been assembled. */
  contextAssembled: Annotation<boolean>({
    reducer: (_state, update) => update,
    default: () => false,
  }),

  /** Set by the summarization guard when TTL or size thresholds are exceeded. */
  needsSummarization: Annotation<boolean>({
    reducer: (_state, update) => update,
    default: () => false,
  }),

  /** Error propagation channel (null = no error). */
  error: Annotation<string | null>({
    reducer: (_state, update) => update,
    default: () => null,
  }),

  /**
   * Set by callModel when an epic task was executed and more tasks remain.
   * The worker uses this to auto-enqueue a continuation turn so the
   * orchestrator can keep executing without exceeding the tool-loop limit.
   */
  epicContinuation: Annotation<{
    epicId: string;
    completedTaskTitle: string;
    remainingTasks: number;
  } | null>({
    reducer: (_state, update) => update,
    default: () => null,
  }),
});

export type AgentState = typeof AgentAnnotation.State;
  