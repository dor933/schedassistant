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

export interface AgentAttributes {
  id: AgentId;
  /** Short role label: "AI Default Agent", "Senior backend developer", etc. Must be unique. */
  definition: string;
  /** Name of the agent */
  agentName: string | null;
  /** Detailed instructions merged into the system prompt each turn. */
  coreInstructions: string | null;
  /** Structured persona traits (tone, style, etc.). */
  characteristics: Record<string, unknown> | null;
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

// ─── Single Chats ────────────────────────────────────────────────────────────

/**
 * Canonical 1:1 chat scope identifier (`single_chats.id`).
 *
 * This UUID is **also used as the LangGraph checkpoint `thread_id`** — the
 * application does not keep a separate threads table. LangChain's Postgres
 * checkpointer persists state keyed by this id.
 */
export type SingleChatId = string;

export interface SingleChatAttributes {
  id: SingleChatId;
  userId: UserId;
  agentId: AgentId;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Episodic Memory (model-controlled vector store) ────────────────────────

export interface EpisodicChunkMetadata {
  /** Free-form tags/context the model can attach when saving a memory. */
  [key: string]: unknown;
}

/** Attributes exposed by the EpisodicMemory Sequelize model. */
export interface EpisodicMemoryAttributes {
  id: string;
  /** The agent this memory belongs to (memory follows the agent across chats). */
  agentId: AgentId;
  /** The user on whose behalf the memory was saved (null for agent-wide). */
  userId: UserId | null;
  content: string;
  embedding: number[];
  metadata?: EpisodicChunkMetadata | null;
  createdAt: Date;
}

// ─── Person (parent table) ───────────────────────────────────────────────────

/** Canonical person id — shared primary key of `persons`, `users`, `employees`. */
export type PersonId = number;

export interface PersonAttributes {
  id: PersonId;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── User (database row) ─────────────────────────────────────────────────────
//
// `users.id` IS `persons.id` — the same integer identifies the person across
// every role table they belong to. A person can be a user, an employee, both,
// or neither.

export interface UserAttributes {
  /** Equals the linked `persons.id`. */
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

// ─── Employee (database row) ─────────────────────────────────────────────────

export interface EmployeeAttributes {
  /** Equals the linked `persons.id`. */
  id: PersonId;
  /** Jira user id (for tools that integrate with Jira). */
  jiraIdNumber: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Core Memory ─────────────────────────────────────────────────────────────

/** The two actions supported by the editCoreMemory tool. */
export type CoreMemoryAction = "append" | "rewrite";

// ─── Message Notifications ───────────────────────────────────────────────────

export type NotificationStatus = "delivered" | "seen";

export interface MessageNotificationAttributes {
  id: string;
  /** LangGraph thread id the message was produced on (equal to singleChatId). */
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
  /** singleChatId — used so the client knows which sidebar item to badge. */
  conversationId: string;
  conversationType: "single";
  deliveredAt: Date;
  seenAt: Date | null;
}

// ─── Conversation Messages ──────────────────────────────────────────────────

export interface ConversationMessageAttributes {
  id: string;
  singleChatId: SingleChatId;
  role: "user" | "assistant";
  content: string;
  senderName: string | null;
  requestId: string | null;
  modelSlug: string | null;
  vendorSlug: string | null;
  modelName: string | null;
  createdAt: Date;
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
