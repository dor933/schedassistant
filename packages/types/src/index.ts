// ─── User ────────────────────────────────────────────────────────────────────

/** Canonical user identifier (`users.id` — integer, auto-generated). */
export type UserId = number;

/** Structured identity data stored in the `user_identity` JSONB column on `users`. */
export interface UserIdentity {
  /** Stable profile fields (name, title, location, etc.) — iterate with `Object.entries`. */
  general?: Record<string, unknown>;
  /** Role- or function-specific context — iterate with `Object.entries`. */
  scope?: Record<string, unknown>;
  role?: string;
  department?: string;
  manager?: string;
  /** Place and IANA timezone together, e.g. `Israel (Asia/Jerusalem)` — prefer this over separate `timezone`. */
  location?: string;
  /** @deprecated Prefer `location` with timezone embedded. Kept for older rows. */
  timezone?: string;
  startDate?: string;
  [key: string]: unknown;
}

// ─── Agents (distinct personas / specializations / product lines) ─────────────

/** Canonical agent identifier (`agents.id`). */
export type AgentId = string;

/** Shape of an entry in `agents.ongoing_requests` (JSONB). */
export interface OngoingRequest {
  id: string;
  userId: UserId;
  request: string;
  createdAt: string;
}

export interface AgentAttributes {
  id: AgentId;
  /** Short role label: "AI Default Agent", "Senior backend developer", etc. Must be unique. */
  definition: string;
  /** Name of the agent */
  agentName: string | null;
  /** Detailed instructions merged into the system prompt each turn. */
  coreInstructions: string | null;
  /** Structured persona traits (tone, style, etc.) — rendered as "Your Characteristics" in context. */
  characteristics: Record<string, unknown> | null;
  /** Ongoing user requests for this agent. */
  ongoingRequests: OngoingRequest[] | null;
  /**
   * Canonical LangGraph checkpoint `thread_id` for this agent.
   * All groups and single chats that reference this agent share this thread / history.
   */
  activeThreadId: string | null;
  /** The user who created this agent (null for legacy/seeded agents). */
  createdByUserId: UserId | null;
  /** The default LLM model for this agent (references models.id). */
  modelId: string | null;
  /** Free-form notes the agent maintains about important information it should always remember. */
  agentNotes: string | null;
  /** Absolute path to this agent's persistent workspace folder for .md files. */
  workspacePath: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── MCP Servers ────────────────────────────────────────────────────────────

export interface McpServerAttributes {
  id: number;
  /** Unique display name for this MCP server (e.g. "bash", "github"). */
  name: string;
  /** Transport protocol — currently only "stdio" is supported. */
  transport: string;
  /** CLI command to launch the server (e.g. "npx", "uvx"). */
  command: string;
  /** Arguments passed to the command. */
  args: string[];
  /** Optional environment variables. Placeholders like `{{VAR}}` are resolved at runtime. */
  env: Record<string, string> | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Vendors & Models ────────────────────────────────────────────────────────

export type VendorId = string;
export type ModelId = string;

export interface VendorAttributes {
  id: VendorId;
  name: string;
  slug: string;
  /** Encrypted API key for this vendor (null = not configured). */
  apiKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ModelAttributes {
  id: ModelId;
  vendorId: VendorId;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Groups ──────────────────────────────────────────────────────────────────

/** Canonical group identifier (`groups.id`). */
export type GroupId = string;

/** Canonical 1:1 chat scope identifier (`single_chats.id` when that table exists). */
export type SingleChatId = string;

export interface SingleChatAttributes {
  id: SingleChatId;
  userId: UserId;
  agentId: AgentId;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GroupAttributes {
  id: GroupId;
  name: string;
  agentId: AgentId;
  createdAt: Date;
  updatedAt: Date;
}

export interface GroupMemberAttributes {
  id: string;
  groupId: GroupId;
  userId: UserId;
  createdAt: Date;
}

// ─── Agent Sessions ──────────────────────────────────────────────────────────

/** Shape of the `summary` JSONB column on `threads`. */
export interface SessionSummary {
  text: string;
  createdAt: string;
  messageCount?: number;
  tokenCount?: number;
}

/** Attributes exposed by the `Thread` Sequelize model (`threads` table). */
export interface ThreadAttributes {
  /** The thread ID — also used as the LangGraph checkpoint thread_id. */
  id: string;
  userId: UserId | null;
  /** The agent serving this thread — used for agent-level memory & summary retrieval. */
  agentId: AgentId | null;
  title?: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date | null;
  lastActivityAt?: Date | null;
  ttlExpiresAt?: Date | null;
  summarizedAt?: Date | null;
  summary?: SessionSummary | null;
  checkpointSizeBytes?: number | null;
}

// ─── Episodic Memory ─────────────────────────────────────────────────────────

/** Metadata stored alongside each episodic chunk. */
export interface EpisodicChunkMetadata {
  threadId?: string;
  chunkIndex?: number;
  summarizedAt?: string;
  [key: string]: unknown;
}

/** Attributes exposed by the EpisodicMemory Sequelize model. */
export interface EpisodicMemoryAttributes {
  id: string;
  userId: UserId;
  /** FK to `threads.thread_id` — kept for legacy; prefer agentId for retrieval. */
  threadId: string;
  /** FK to `agents.id` — primary key for memory retrieval (persists across conversations). */
  agentId: AgentId | null;
  content: string;
  embedding: number[];
  metadata?: EpisodicChunkMetadata | null;
  createdAt: Date;
}

// ─── User (database row) ─────────────────────────────────────────────────────

export interface UserAttributes {
  id: UserId;
  /** Unique login handle — lowercase alphanumeric + underscores only. */
  userName: string;
  externalRef?: string | null;
  displayName?: string | null;
  userIdentity?: UserIdentity | null;
  password?: string | null;
  /** FK to `roles.id` — determines the user's access level. */
  roleId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Core Memory ─────────────────────────────────────────────────────────────

/** The two actions supported by the editCoreMemory tool. */
export type CoreMemoryAction = "append" | "rewrite";

// ─── Context Builder ─────────────────────────────────────────────────────────

/** One group member’s profile for prompt assembly (`group_members` → `users`). */
export interface GroupMemberContextProfile {
  userId: UserId;
  displayName: string | null;
  userIdentity: UserIdentity | null;
}

/** The assembled context injected into the LLM prompt each turn. */
export interface AssembledContext {
  /** From `agents.core_instructions` when `agentId` is set in graph state. */
  agentCoreInstructions: string | null;
  coreMemory: string;
  ongoingRequests: string[] | null;
  episodicSnippets: string[];
  recentSessionSummaries: SessionSummary[];
  /** Messages formatted from LangGraph checkpoint state for this turn (max 50 in snapshot). */
  recentCheckpointMessageCount: number;
  /** Rows pulled from `conversation_messages` for this single chat or group (max 50). */
  recentConversationMessageCount: number;
  /** Set for 1:1 / non-group turns; omitted when `groupMemberIdentities` is used. */
  userIdentity: UserIdentity | null;
  /**
   * When `group_id` is active: every member’s `users` row (via `group_members`),
   * used instead of a single `userIdentity`.
   */
  groupMemberIdentities: GroupMemberContextProfile[] | null;
  systemPrompt: string;
}

// ─── Message Notifications ───────────────────────────────────────────────────

export type NotificationStatus = "delivered" | "seen";

export interface MessageNotificationAttributes {
  id: string;
  /** Conversation scope: the group or single-chat the message belongs to. */
  threadId: string;
  /** The user this notification targets. */
  recipientId: UserId;
  /** The user who triggered the message (null for agent-generated). */
  senderId: UserId | null;
  /** Identifier for the specific message (requestId from the chat flow). */
  messageId: string;
  /** Short preview text for the notification badge. */
  preview: string | null;
  status: NotificationStatus;
  /** groupId or singleChatId — used so the client knows which sidebar item to badge. */
  conversationId: string;
  conversationType: "group" | "single";
  deliveredAt: Date;
  seenAt: Date | null;
}

// ─── Conversation Messages ──────────────────────────────────────────────────

export interface ConversationMessageAttributes {
  id: string;
  groupId: GroupId | null;
  singleChatId: SingleChatId | null;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  senderName: string | null;
  requestId: string | null;
  modelSlug: string | null;
  vendorSlug: string | null;
  modelName: string | null;
  createdAt: Date;
}

// ─── Session Summarization ───────────────────────────────────────────────────

/** Schema returned by the LLM during session summarization (withStructuredOutput). */
export interface SessionSummarizationResult {
  summary: string;
  chunks: string[];
}

// ─── Validation (Zod schemas) ───────────────────────────────────────────────

export {
  userNameSchema,
  passwordSchema,
  displayNameSchema,
  registerSchema,
  loginSchema,
  type RegisterInput,
  type LoginInput,
} from "./validation";
