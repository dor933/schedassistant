// ─── Organization (tenant) ─────────────────────────────────────────────────

export type OrganizationId = string;

export interface OrganizationAttributes {
  id: OrganizationId;
  name: string;
  /** URL-safe identifier. Unique. */
  slug: string | null;
  /** Logo as a base64 data URL — no file-storage infra. */
  logo: string | null;
  /**
   * FK to `agents.id` — the single, currently active system web-search agent
   * for this org. Exactly one of the two web-search system agents
   * (Gemini-powered `web_search` / Brave-powered `web_search_brave`) is
   * pointed to at any time. Resolved at runtime when an agent delegates a
   * web search so queries always land on the org's chosen agent.
   */
  webSearchAgentId: AgentId | null;
  /**
   * Primary Google Workspace domain mapped to this tenant (the `hd` claim on
   * Google id tokens, e.g. `grahamy.com`). Unique. When set, any successful
   * Google SSO sign-in whose `hd` equals this value is routed into this org,
   * and users are JIT-provisioned on first login.
   */
  googleWorkspaceDomain: string | null;
  /**
   * Optional per-org Google OAuth client id. Used to scope audience validation
   * when each tenant has its own OAuth client. When null, the env-configured
   * default client id list is accepted instead.
   */
  googleClientId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fixed UUIDs for the two seeded web-search system agents (see migration 20240101000083). */
export const WEB_SEARCH_AGENT_ID_GEMINI = "00000000-0000-4000-a000-000000000200";
export const WEB_SEARCH_AGENT_ID_BRAVE = "00000000-0000-4000-a000-000000000201";
export type WebSearchChoice = "gemini" | "brave";

/**
 * Skills that are always auto-assigned to every agent and never appear in the
 * admin UI. They describe the in-house tools (agent notes, workspace, skill
 * library) that are hardcoded into every call. Admins cannot attach or detach
 * them; agents always have access.
 */
export const AUTO_ASSIGNED_SKILL_SLUGS: readonly string[] = [
  "dev-in-house-agent-notes",
  "dev-in-house-workspace",
  "dev-in-house-skill-library",
];
export const AUTO_ASSIGNED_SKILL_SLUG_SET: ReadonlySet<string> = new Set(
  AUTO_ASSIGNED_SKILL_SLUGS,
);

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
export type AgentType = "primary" | "system" | "external";

export interface AgentAttributes {
  id: AgentId;
  /** Discriminator: 'primary' for user-facing agents, 'system' for specialist/executor agents, 'external' for roundtable-only agents. */
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
  /** When true, this agent cannot be reconfigured via the admin UI. */
  isLocked: boolean;
  /** FK to `organizations.id` — the tenant this agent belongs to. */
  organizationId: OrganizationId;
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
  /** How confident the summarizer was that key facts are accurately captured. */
  confidence?: "high" | "medium" | "low";
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

/**
 * How this user authenticates.
 *  - `local`: classic username + bcrypt password.
 *  - `google`: JIT-provisioned from Google Workspace SSO. No password is
 *    stored; identity is asserted by a valid Google id token matching the
 *    org's `googleWorkspaceDomain`.
 */
export type AuthProvider = "local" | "google";

export interface UserAttributes {
  id: UserId;
  /** Unique login handle — for SSO users this is the email; for local users, lowercase alphanumeric + underscores. */
  userName: string;
  externalRef?: string | null;
  displayName?: string | null;
  userIdentity?: UserIdentity | null;
  password?: string | null;
  /** FK to `roles.id` — determines the user's access level. */
  roleId?: string | null;
  /** FK to `organizations.id` — the tenant this user belongs to. */
  organizationId: OrganizationId;
  /** Which auth flow owns this user. Defaults to `local` for all pre-existing rows. */
  authProvider: AuthProvider;
  /**
   * Stable provider-side user id (e.g. Google `sub`). Unique per
   * `(authProvider, externalSub)`. Null for local users.
   */
  externalSub?: string | null;
  /**
   * Timestamp of this user's most recent successful login. NULL means the
   * user has never signed in yet — the client uses this to decide whether to
   * play the "welcome" launch animation. Updated on every successful login
   * (both password and Google SSO).
   */
  lastLoginAt?: Date | null;
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
  /** CLI agent name (--agent-name) to use for this repo's tasks. */
  agentName: string | null;
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

// ─── Agent Cron Jobs ─────────────────────────────────────────────────────────

export type AgentCronJobId = string;
export type AgentCronJobStatus = "success" | "failed" | "enqueued";

export interface AgentCronJobAttributes {
  id: AgentCronJobId;
  agentId: AgentId;
  organizationId: OrganizationId;
  createdByUserId: UserId | null;
  /** Human label shown in the admin UI. */
  name: string;
  /** Message sent to the agent on every tick. */
  prompt: string;
  /** Standard 5-field cron expression (minute hour dom month dow). */
  cronExpression: string;
  /** IANA timezone string, default "UTC". */
  timezone: string;
  enabled: boolean;
  lastRunAt: Date | null;
  lastStatus: AgentCronJobStatus | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Validation (Zod schemas) ───────────────────────────────────────────────

export {
  userNameSchema,
  passwordSchema,
  displayNameSchema,
  registerSchema,
  registerOrganizationSchema,
  webSearchChoiceSchema,
  loginSchema,
  googleLoginSchema,
  googleBootstrapSchema,
  googleVerifyDomainSchema,
  type RegisterInput,
  type RegisterOrganizationInput,
  type LoginInput,
  type GoogleLoginInput,
  type GoogleBootstrapInput,
  type GoogleVerifyDomainInput,
} from "./validation";
