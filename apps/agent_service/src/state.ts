import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import { AgentId, SessionFileEntry, UserId, UserIdentity } from "@scheduling-agent/types";

import { mergeSessionFilesByPath } from "./workspace/sessionWorkspace";

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

  /**
   * Conversation messages managed by the checkpointer.
   *
   * Uses LangGraph's `messagesStateReducer` so updates can append new messages,
   * replace by id, OR remove specific messages via `RemoveMessage` (used by the
   * roundtable resume flow to trim trailing orphan messages from a failed turn
   * before re-enqueueing it).
   */
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
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

  /**
   * Absolute path to this thread's per-thread workspace folder
   * (`<agent.workspacePath>/threads/<threadId>/`). Set by the context builder
   * when the thread first runs through a graph; null when the agent has no
   * workspace (e.g. system agents, agents without filesystem MCP).
   *
   * Used by FS-write instrumentation to know which writes belong to this
   * session, and by `read_session_file` to scope reads.
   */
  sessionWorkspacePath: Annotation<string | null>({
    reducer: (state, update) => (update !== undefined ? update : state),
    default: () => null,
  }),

  /**
   * Files written or modified during this session under `sessionWorkspacePath`.
   * Populated by draining the per-thread ledger inside the call-model node
   * after each tool round; consumed by `sessionSummarizationNode` when the
   * thread is summarised. Reducer merges by path so the latest write wins.
   */
  sessionFiles: Annotation<SessionFileEntry[]>({
    reducer: mergeSessionFilesByPath,
    default: () => [],
  }),

  /** Roundtable ID when this turn is part of a multi-agent roundtable. */
  roundtableId: Annotation<string | null>({
    reducer: (_state, update) => (update !== undefined ? update : _state),
    default: () => null,
  }),

  /** Roundtable metadata injected by the worker for the context builder. */
  roundtableConfig: Annotation<{
    topic: string;
    roundNumber: number;
    maxTurnsPerAgent: number;
    agentOrder: { agentId: string; definition: string }[];
    /** True when the roundtable's creator takes a turn each round. */
    includeUser: boolean;
    /** The participating user (loaded once by the worker). */
    participantUser: {
      id: UserId;
      displayName: string;
      userIdentity: UserIdentity | null;
    } | null;
  } | null>({
    reducer: (_state, update) => (update !== undefined ? update : _state),
    default: () => null,
  }),
});

export type AgentState = typeof AgentAnnotation.State;
  