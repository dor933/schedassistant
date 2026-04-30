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
   * Admin-authored free-text summary about the organization / company / team.
   * Prepended to every agent's system prompt so every agent shares common
   * grounding about who it's working for. Null when not yet filled in.
   */
  summary: string | null;
  /**
   * FK to `agents.id` — the single, currently active system web-search agent
   * for this org. Exactly one of the two web-search system agents
   * (Gemini-powered `web_search` / Tavily-powered `web_search_tavily`) is
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

/** Fixed UUIDs for the two seeded web-search system agents (see migrations 20240101000083 / 20240101000095). */
export const WEB_SEARCH_AGENT_ID_GEMINI = "00000000-0000-4000-a000-000000000200";
export const WEB_SEARCH_AGENT_ID_TAVILY = "00000000-0000-4000-a000-000000000201";
export type WebSearchChoice = "gemini" | "tavily";

/**
 * Skills that every agent always has available and that never appear in the
 * admin UI — admins cannot attach or detach them.
 *
 * The union (`AUTO_ASSIGNED_SKILL_SLUGS`) is what the admin skills list is
 * filtered against, so all auto-assigned slugs regardless of tier must be in
 * it. Runtime surfacing is finer-grained: `CORE_AUTO_ASSIGNED_SKILL_SLUGS`
 * is injected for every agent, while `FILESYSTEM_MCP_SKILL_SLUGS` is only
 * injected for agents that actually have the filesystem MCP server attached
 * (checked via `hasFilesystemMcp`). Agents without it get no workspace/library
 * guidance at all — they have no filesystem tools to act on it anyway.
 */
export const CORE_AUTO_ASSIGNED_SKILL_SLUGS: readonly string[] = [
  "dev-in-house-agent-notes",
  "dev-in-house-skill-library",
];
export const FILESYSTEM_MCP_SKILL_SLUGS: readonly string[] = [
  "dev-in-house-workspace",
  "dev-in-house-library-mcp",
];
export const AUTO_ASSIGNED_SKILL_SLUGS: readonly string[] = [
  ...CORE_AUTO_ASSIGNED_SKILL_SLUGS,
  ...FILESYSTEM_MCP_SKILL_SLUGS,
];
export const CORE_AUTO_ASSIGNED_SKILL_SLUG_SET: ReadonlySet<string> = new Set(
  CORE_AUTO_ASSIGNED_SKILL_SLUGS,
);
export const FILESYSTEM_MCP_SKILL_SLUG_SET: ReadonlySet<string> = new Set(
  FILESYSTEM_MCP_SKILL_SLUGS,
);
export const AUTO_ASSIGNED_SKILL_SLUG_SET: ReadonlySet<string> = new Set(
  AUTO_ASSIGNED_SKILL_SLUGS,
);

/**
 * System agents that are SHARED by design — every primary in the org needs
 * to be able to delegate to them, so they cannot have an `owningPrimaryAgentId`.
 * Both the admin UI (disables the owner select) and the server (rejects PATCH
 * with a non-null owner) read from this list.
 *
 * Members:
 *  - `google_workspace_agent` — single Gmail/Calendar/Drive specialist per org;
 *    primary agents inherit grants and route through it.
 *  - `web_search` — Gemini-grounded web search; org picks one active web-search
 *    agent via `organizations.web_search_agent_id`, but BOTH candidates must
 *    stay shared so any primary may end up routing to whichever is active.
 *  - `web_search_tavily` — Tavily-backed alternative to the above.
 */
export const SHARED_SYSTEM_AGENT_SLUGS: readonly string[] = [
  "google_workspace_agent",
  "web_search",
  "web_search_tavily",
];
export const SHARED_SYSTEM_AGENT_SLUG_SET: ReadonlySet<string> = new Set(
  SHARED_SYSTEM_AGENT_SLUGS,
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
export type AgentType = "primary" | "system" | "external" | "application";

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
  /**
   * The primary agent this system agent is locked to. NULL = shared / org-wide
   * (the legacy default — any primary in the org may discover and delegate
   * to it). Non-NULL = private specialist; only the named primary agent may
   * see it in `list_system_agents` or call it via `delegate_to_deep_agent`.
   * Schema-enforced as nullable only for system rows.
   */
  owningPrimaryAgentId: AgentId | null;

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
  /**
   * Owning tenant. `null` = platform-shared (curated public registry,
   * read-only in the UI, installable into any org). Non-null = private to
   * that organization; only super_admins of that org may mutate.
   */
  organizationId: OrganizationId | null;
  /** Display name. Unique per (organization_id, name); also unique among null-org rows. */
  name: string;
  /** Optional human-readable summary shown in the public-registry browser. */
  description: string | null;
  /** Transport protocol — currently only "stdio" is supported. */
  transport: string;
  /** CLI command to launch the server (e.g. "npx", "uvx", "node"). */
  command: string;
  /** Arguments passed to the command. */
  args: string[];
  /** Optional environment variables. Placeholders like `{{VAR}}` are resolved at runtime. */
  env: Record<string, string> | null;
  /**
   * Inline JS source for "custom script" MCPs. When set, the admin pastes
   * the server's source into the UI; the controller writes it to
   * `/home/agent/.codex/mcp-scripts/<id>.js`, sets `command="node"`, and
   * sets `args=["/home/agent/.codex/mcp-scripts/<id>.js"]` automatically.
   * Only super_admins can create or edit a row with a non-null script.
   */
  scriptContent: string | null;
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

/**
 * One file produced or modified inside a thread's per-thread session workspace
 * (`<agent.workspacePath>/threads/<threadId>/`). Captured by the FS-write
 * instrumentation during the session, then enriched with an LLM-written
 * `summary` when the session is summarised.
 */
export interface SessionFileEntry {
  /** Path relative to the per-thread workspace root, e.g. "research/pricing_brief.md". */
  path: string;
  /** Bytes at the most recent write (best-effort; lets retrieval detect drift). */
  bytes: number;
  /** ISO timestamp of the most recent write within this session. */
  updatedAt: string;
  /** What wrote it — e.g. "deep_agent:<executor_id>", "primary_agent". */
  source?: string;
  /**
   * 2–4 sentence content summary written by `sessionSummarizationNode` so the
   * agent can decide whether to read the file before fetching it. Absent
   * during a live session; populated when the summary is persisted.
   */
  summary?: string;
}

/** Shape of the `summary` JSONB column on `threads`. */
export interface SessionSummary {
  text: string;
  createdAt: string;
  messageCount?: number;
  tokenCount?: number;
  /** How confident the summarizer was that key facts are accurately captured. */
  confidence?: "high" | "medium" | "low";
  /** Absolute path to this thread's session workspace folder when one was created. */
  workspacePath?: string;
  /**
   * Files written or modified during the session. Empty array means the
   * instrumentation ran but nothing was written; absent means the session
   * had no workspace at all.
   */
  files?: SessionFileEntry[];
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

/**
 * What kind of episodic chunk this row holds. Used as a metadata hint, not a
 * separate index/namespace — default retrieval ranks all kinds together.
 *  - "conversation" (default, also implied when absent): a slice of dialogue.
 *  - "file_summary": describes a file written into a session workspace; the
 *    `sessionFilePath` field gives the file's path relative to the per-thread
 *    workspace root so an agent can call `read_session_file` to fetch it.
 */
export type EpisodicChunkKind = "conversation" | "file_summary";

/** Metadata stored alongside each episodic chunk. */
export interface EpisodicChunkMetadata {
  threadId?: string;
  chunkIndex?: number;
  summarizedAt?: string;
  /** What this chunk is — see EpisodicChunkKind. Absent = "conversation". */
  kind?: EpisodicChunkKind;
  /**
   * For chunks with `kind === "file_summary"`: the file's path relative to
   * the per-thread workspace root, so retrieval can resolve it back to a
   * concrete file under `<agent.workspacePath>/threads/<threadId>/`.
   */
  sessionFilePath?: string;
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
 *  - `client_app`: JIT-provisioned from an upstream client application that
 *    invokes application agents on the user's behalf. No password is stored;
 *    the client app owns auth and forwards the user's id to us. These users
 *    cannot log in to the chat UI — they exist purely so deep-agent
 *    conversation continuity can be keyed to a stable internal `users.id`.
 */
export type AuthProvider = "local" | "google" | "client_app";

export interface UserAttributes {
  id: UserId;
  /** Unique login handle — for SSO users this is the email; for local users, lowercase alphanumeric + underscores. */
  userName: string;
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
   * Stable provider-side user id (e.g. Google `sub`, or the client app's
   * user id). Unique per `(authProvider, externalSub)` for SSO and per
   * `(clientApplicationId, externalSub)` for client-app users. Null for
   * local users.
   */
  externalSub?: string | null;
  /**
   * Timestamp of this user's most recent successful login. NULL means the
   * user has never signed in yet — the client uses this to decide whether to
   * play the "welcome" launch animation. Updated on every successful login
   * (both password and Google SSO).
   */
  lastLoginAt?: Date | null;
  /**
   * For `client_app`-provider users: the upstream application that JIT-mirrored
   * this row. Null for native (`local`) and SSO (`google`) users.
   */
  clientApplicationId?: string | null;
  /**
   * Optional payload pushed by the upstream client app to enrich the agent's
   * view of the user (e.g. role, plan, language). The agent may surface
   * fields from this in prompts; never used for authentication.
   */
  externalMetadata?: Record<string, unknown> | null;
  /** Last time we refreshed cached fields from the client app (JIT or webhook). */
  externalSyncedAt?: Date | null;
  /** Soft-delete marker. Set when the upstream app reports the user is gone. */
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Client Applications ────────────────────────────────────────────────────

/** PK of `client_applications`. */
export type ClientApplicationId = string;

/**
 * An upstream application authorised to invoke application agents on behalf
 * of its end users. Rows hold the per-client API token (hashed) and own a
 * namespace of mirrored users via `users.client_application_id` /
 * `users.external_sub`.
 */
export interface ClientApplicationAttributes {
  id: ClientApplicationId;
  organizationId: OrganizationId;
  name: string;
  /** URL-safe identifier; used as the prefix when generating mirrored `user_name`s. */
  slug: string;
  /** Hashed (bcrypt/argon2) token. Null = client app not yet activated. */
  apiTokenHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Application Agent Threads ──────────────────────────────────────────────

/** PK of `application_agent_threads`. */
export type ApplicationAgentThreadId = string;

/**
 * Stable LangGraph thread per (user, application_agent) pair. Looked up on
 * every invocation so the same end-user resumes their existing conversation
 * with each application agent across REST calls and primary-tool delegations.
 */
export interface ApplicationAgentThreadAttributes {
  id: ApplicationAgentThreadId;
  userId: UserId;
  applicationAgentId: AgentId;
  threadId: string;
  createdAt: Date;
  lastUsedAt: Date;
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
  /**
   * The agent's `workspacePath` (from `agents.workspace_path`), exposed here
   * so the surrounding node can derive the per-thread session workspace
   * without re-reading the agent row. `null` when the agent has no workspace.
   */
  agentWorkspacePath?: string | null;
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
/**
 * "code_change": default — produces commits and a PR; gates next stage on PR approval.
 * "plan":        research/design only — no commits, no PR; auto-completes and unblocks
 *                the next stage as soon as all its tasks finish.
 */
export type TaskStageKind = "code_change" | "plan";
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
  kind: TaskStageKind;
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
  /**
   * Absolute path of the per-task summary `.md` the CLI wrote to the
   * current session folder on the most recent successful run. Updated on
   * every `executeTask` (including retries) so it always points at the
   * latest attempt's file — never at a stale path from a different thread.
   * `null` when the task hasn't run successfully (yet) or predates the
   * `summary_file_path` migration.
   */
  summaryFilePath: string | null;
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
  /**
   * FK to `cli_executions.id` for the underlying CLI subprocess this attempt
   * spawned. Nullable for rows predating the cli_executions ledger.
   */
  cliExecutionId: CliExecutionId | null;
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

// ─── CLI Executions (provider-agnostic) ─────────────────────────────────────

export type CliExecutionId = string;

/** Which CLI binary this row describes. New providers add a value here. */
export type CliProvider = "claude" | "codex";

/**
 * Lifecycle of a single CLI invocation.
 * - "running":   spawn succeeded, process still alive (or row not yet finalized).
 * - "completed": process exited 0 and we parsed a result.
 * - "failed":    process exited non-zero, or we couldn't parse the output.
 * - "killed":    swept on startup as a stale `running` row, or explicitly aborted.
 */
export type CliExecutionStatus = "running" | "completed" | "failed" | "killed";

/** What part of the system spawned this CLI run. Used for filtering / billing. */
export type CliInvokedVia =
  | "epic_orchestrator"     // executeTask() / continueRemainingTasks()
  | "architecture_overview" // generateArchitectureOverview()
  | "run_cli_tool";         // RunClaudeCliTool / RunCodexCliTool grant

export interface CliExecutionAttributes {
  id: CliExecutionId;
  provider: CliProvider;
  /**
   * Agent that triggered the run. Nullable so admin-triggered runs (e.g.
   * the repo "generate architecture overview" endpoint) can be recorded
   * without faking an attribution.
   */
  agentId: AgentId | null;
  userId: UserId | null;
  threadId: string | null;
  /** Optional link back to the epic task that triggered this run. */
  agentTaskId: AgentTaskId | null;
  cwd: string;
  prompt: string;
  systemPrompt: string | null;
  /** Resolved CLI agent name (`--agent-name` for claude). Provider may not use it. */
  cliAgentName: string | null;
  /** Concrete model id reported by the CLI's structured output, when available. */
  model: string | null;
  /** Session id captured from the CLI's structured output (provider-opaque). */
  sessionId: string | null;
  /** Set when this run resumed a prior `cli_executions.session_id`. */
  parentSessionId: string | null;
  status: CliExecutionStatus;
  result: string | null;
  stderr: string | null;
  exitCode: number | null;
  /** OS pid of the CLI process. Used by the cross-provider busy check / kill. */
  pid: number | null;
  costUsd: number | null;
  durationMs: number | null;
  /** Provider-specific. Claude reports it; codex generally doesn't. */
  numTurns: number | null;
  isError: boolean | null;
  invokedVia: CliInvokedVia;
  /** Provider-specific extras (flags, profile, reasoning_effort, allowedTools, …). */
  providerMetadata: Record<string, unknown>;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
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

// ─── Agent ↔ User Google Scopes ─────────────────────────────────────────────

export type AgentUserScopeId = string;

/**
 * Closed set of Google operations that can be granted to an agent on a
 * subject user's data. Kept in sync with the CHECK constraint in
 * migration 20240101000090-create-agent-user-scopes.
 */
export type GoogleScope =
  | "calendar.read"
  | "calendar.write"
  | "drive.read"
  | "drive.write"
  | "gmail.read"
  | "gmail.send";

export interface AgentUserScopeAttributes {
  id: AgentUserScopeId;
  agentId: AgentId;
  /** The user whose Google data the agent may act on. */
  subjectUserId: UserId;
  organizationId: OrganizationId;
  scope: GoogleScope;
  /** Admin who issued the grant; null if the grantor was deleted. */
  grantedByUserId: UserId | null;
  grantedAt: Date;
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
  organizationSummarySchema,
  webSearchChoiceSchema,
  loginSchema,
  googleLoginSchema,
  googleBootstrapSchema,
  googleVerifyDomainSchema,
  type RegisterInput,
  type RegisterOrganizationInput,
  type OrganizationSummaryInput,
  type LoginInput,
  type GoogleLoginInput,
  type GoogleBootstrapInput,
  type GoogleVerifyDomainInput,
} from "./validation";
