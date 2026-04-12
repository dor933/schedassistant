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

// ─── Agents (unified: primary + system) ─────────────────────────────────────

/** Canonical agent identifier (`agents.id`). */
export type AgentId = string;

/** Discriminator for the unified agents table. */
export type AgentType = "primary" | "system";

export interface AgentAttributes {
  id: AgentId;
  /** Discriminator: 'primary' for user-facing agents, 'system' for specialist/executor agents. */
  type: AgentType;

  // ── Primary agent fields ──
  /** Short role label: "AI Default Agent", "Senior backend developer", etc. Partial unique (primary only). */
  definition: string | null;
  /** Detailed instructions merged into the system prompt each turn (primary agents). */
  coreInstructions: string | null;
  /** Structured persona traits (tone, style, etc.) — rendered as "Your Characteristics" in context. */
  characteristics: Record<string, unknown> | null;
  /** Canonical LangGraph checkpoint thread_id for this agent (primary agents). */
  activeThreadId: string | null;
  /** The user who created this agent (null for legacy/seeded agents). */
  createdByUserId: UserId | null;
  /** The default LLM model for this agent — references models.id (primary agents). */
  modelId: string | null;
  /** Free-form notes the agent maintains about important information it should always remember. */
  agentNotes: string | null;
  /** Absolute path to this agent's persistent workspace folder for .md files. */
  workspacePath: string | null;

  // ── System agent fields ──
  /** Unique slug identifier for system agents. Partial unique (system only). */
  slug: string | null;
  /** System agent instructions sent to the executor. */
  instructions: string | null;
  /** LLM model slug string for system agents (resolved by slug, not FK). */
  modelSlug: string | null;
  /** Arbitrary tool configuration for system agents (e.g. googleSearch flag). */
  toolConfig: Record<string, unknown> | null;
  /** Constant user identity for system agents — scopes memory and context. */
  userId: UserId | null;

  // ── Shared fields ──
  /** Display name of the agent. */
  agentName: string | null;
  /** Free-form description (primarily used by system agents). */
  description: string | null;
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

// ─── Tools (code-defined tool registry) ────────────────────────────────────

export interface ToolAttributes {
  id: number;
  /** Unique tool name matching the code-defined function (e.g. "delegateToDeepAgent"). */
  name: string;
  /** Kebab-case slug for lookups. */
  slug: string;
  /** What this tool does. */
  description: string | null;
  /** Grouping category: "delegation", "memory", "workspace", etc. */
  category: string | null;
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
  /** FK to `repositories.id` — scopes chunk to a specific repository (nullable). */
  repositoryId: RepositoryId | null;
  /** FK to `projects.id` — scopes chunk to a specific project (nullable). */
  projectId: ProjectId | null;
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

// ─── Code Task Workflow ─────────────────────────────────────────────────────

export type ProjectId = string;
export type RepositoryId = string;
export type EpicTaskId = string;
export type TaskStageId = string;
export type AgentTaskId = string;
export type TaskExecutionId = string;

export type EpicTaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";
export type TaskStageStatus = "pending" | "in_progress" | "pr_pending" | "completed" | "failed" | "cancelled";
export type AgentTaskStatus = "pending" | "ready" | "in_progress" | "completed" | "failed" | "cancelled";
export type TaskExecutionStatus = "running" | "completed" | "failed" | "cancelled";
export type PrStatus = "draft" | "open" | "approved" | "merged" | "closed" | "changes_requested";

export interface ProjectAttributes {
  id: ProjectId;
  name: string;
  description: string | null;
  userId: UserId;
  /** High-level project architecture: how components fit together, major boundaries. */
  architectureOverview: string | null;
  /** Languages, frameworks, major dependencies (e.g. "React 18, Node 20, PostgreSQL 15"). */
  techStack: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RepositoryAttributes {
  id: RepositoryId;
  projectId: ProjectId;
  name: string;
  url: string;
  defaultBranch: string;
  /** Repo-specific structure: folder tree, component layout, naming conventions, etc. */
  architectureOverview: string | null;
  /** Absolute path to the local clone on this machine (e.g. "/home/user/projects/my-api"). */
  localPath: string | null;
  /** How to install deps, run dev server, build, test, etc. */
  setupInstructions: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EpicTaskAttributes {
  id: EpicTaskId;
  title: string;
  description: string;
  status: EpicTaskStatus;
  projectId: ProjectId;
  userId: UserId;
  agentId: AgentId;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface EpicTaskRepositoryAttributes {
  id: string;
  epicTaskId: EpicTaskId;
  repositoryId: RepositoryId;
  createdAt: Date;
}

export interface TaskStageAttributes {
  id: TaskStageId;
  epicTaskId: EpicTaskId;
  title: string;
  description: string | null;
  status: TaskStageStatus;
  sortOrder: number;
  prUrl: string | null;
  prNumber: number | null;
  prStatus: PrStatus | null;
  repositoryId: RepositoryId | null;
  branchName: string | null;
  baseCommitSha: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface AgentTaskAttributes {
  id: AgentTaskId;
  taskStageId: TaskStageId;
  title: string;
  description: string | null;
  status: AgentTaskStatus;
  sortOrder: number;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface TaskExecutionAttributes {
  id: TaskExecutionId;
  agentTaskId: AgentTaskId;
  attemptNumber: number;
  status: TaskExecutionStatus;
  cliSessionId: string | null;
  prompt: string | null;
  result: string | null;
  error: string | null;
  feedback: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface TaskDependencyAttributes {
  id: string;
  taskId: AgentTaskId;
  dependsOnTaskId: AgentTaskId;
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
