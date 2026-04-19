import { APP_URL_PREFIX } from "../constants";

const BASE = `${APP_URL_PREFIX}/api`;

function getToken(): string | null {
  return localStorage.getItem("token");
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }

  return res.json() as Promise<T>;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export interface ConversationModelInfo {
  id: string;
  name: string;
  slug: string;
  vendor: { id: string; name: string; slug: string } | null;
}

export interface GroupConversation {
  id: string;
  name: string;
  agentId: string;
  agentDefinition: string | null;
  model: ConversationModelInfo | null;
}

export interface SingleChatConversation {
  id: string;
  agentId: string;
  title: string | null;
  model: ConversationModelInfo | null;
}

export interface Conversations {
  groups: GroupConversation[];
  singleChats: SingleChatConversation[];
}

export interface OrganizationInfo {
  id: string;
  name: string;
  slug: string | null;
  logo: string | null;
  /** Currently active web-search system agent for this org (null if unset). */
  webSearchAgentId?: string | null;
}

export type WebSearchChoice = "gemini" | "tavily";

export interface LoginResponse {
  token: string;
  user: {
    id: number;
    displayName: string | null;
    userIdentity: Record<string, unknown> | null;
    role: string;
  };
  conversations: Conversations;
  organization?: OrganizationInfo | null;
  /**
   * Set by both `/auth/login` and `/auth/google` — true when this is the
   * user's first-ever successful sign-in (server-side `users.last_login_at`
   * was NULL before this request). The client plays the cinematic "welcome"
   * launch animation exactly once per user based on this flag.
   */
  isFirstLogin?: boolean;
}

export function login(userName: string, password: string) {
  return request<LoginResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ userName, password }),
  });
}

/**
 * Google Workspace SSO. `idToken` is the `credential` string returned by the
 * Google Identity Services sign-in callback. Backend verifies, matches the
 * tenant by workspace domain, and JIT-provisions the user on first login.
 */
export function googleLogin(idToken: string) {
  return request<LoginResponse>("/auth/google", {
    method: "POST",
    body: JSON.stringify({ idToken }),
  });
}

/** Onboarding payload — creates an org + admin + N agents.
 *
 * Exactly one of `admin` / `googleBootstrapTicket` must be set: the
 * password path collects username+password from the user; the SSO path
 * redeems a short-lived ticket minted by `googleBootstrap()` so the admin
 * doesn't have to invent a password at all.
 */
export interface RegisterData {
  organization: {
    name: string;
    logo?: string;
    /** Admin-authored free-text summary — prepended to every agent's system prompt. */
    summary?: string;
  };
  admin?: {
    userName: string;
    displayName: string;
    password: string;
  };
  /** Short-lived JWT from `/auth/google-bootstrap` — SSO alternative to `admin`. */
  googleBootstrapTicket?: string;
  agents: Array<{
    definition: string;
    description?: string;
    modelId?: string;
  }>;
  /** Which seeded web-search system agent to mark active (defaults to Gemini). */
  webSearchChoice?: WebSearchChoice;
}

export function register(data: RegisterData) {
  return request<LoginResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

/** Identity surfaced back to the wizard after a successful bootstrap. */
export interface GoogleBootstrapIdentity {
  email: string;
  name: string | null;
  hd: string;
  picture: string | null;
}

/** DNS TXT record the admin must publish to prove they own their `hd` domain. */
export interface BootstrapTxtRecord {
  /** DNS name the TXT record is published at — the Workspace root domain. */
  name: string;
  /** Full record value to paste — includes the `sched-assist-verify=` prefix. */
  value: string;
}

export interface GoogleBootstrapResponse {
  /** Opaque JWT — pass it back in `RegisterData.googleBootstrapTicket`. */
  ticket: string;
  identity: GoogleBootstrapIdentity;
  /** Verification record the admin must publish before `/auth/register` will accept this ticket. */
  txtRecord: BootstrapTxtRecord;
}

/**
 * Pre-registration Google sign-in — verifies the admin's Workspace account
 * BEFORE their org exists. The returned `ticket` starts life unverified; the
 * wizard must swap it for a verified one at `/auth/google-verify-domain`
 * after publishing the TXT record.
 */
export function googleBootstrap(idToken: string) {
  return request<GoogleBootstrapResponse>("/auth/google-bootstrap", {
    method: "POST",
    body: JSON.stringify({ idToken }),
  });
}

export interface GoogleVerifyDomainResponse {
  /** Re-issued bootstrap ticket carrying `verifiedDomain: true`. */
  ticket: string;
  verified: true;
}

/** Error shape returned by `/auth/google-verify-domain` when DNS hasn't propagated. */
export interface GoogleVerifyDomainError {
  error: string;
  details?: {
    expectedPrefix: string;
    expectedValue: string;
    hd: string;
  };
}

/**
 * Redeems an unverified bootstrap ticket for a verified one by running a
 * live DNS TXT lookup on the admin's `hd` domain. Rejects with a 409 (and
 * a structured `details` body) when the record hasn't propagated yet.
 */
export function googleVerifyDomain(ticket: string) {
  return request<GoogleVerifyDomainResponse>("/auth/google-verify-domain", {
    method: "POST",
    body: JSON.stringify({ ticket }),
  });
}

export function getPublicModels() {
  return request<ConversationModelInfo[]>("/auth/public-models");
}

export interface MeResponse {
  id: number;
  displayName: string | null;
  role: string;
  conversations: Conversations;
  organization: OrganizationInfo | null;
}

export function getMe() {
  return request<MeResponse>("/auth/me");
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export interface Session {
  threadId: string;
  userId: number | null;
  groupId: string | null;
  singleChatId: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  /** Display name of the sender (set on human messages when available). */
  senderName?: string;
  /** Model metadata (set on assistant messages). */
  modelSlug?: string;
  vendorSlug?: string;
  modelName?: string;
  createdAt?: string;
}

export interface PaginatedHistory {
  messages: HistoryMessage[];
  total: number;
}

/** Conversation-scoped history — survives thread rotation. */
export function getConversationHistory(
  conversationId: string,
  conversationType: "group" | "single",
  opts?: { limit?: number; offset?: number },
) {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.offset != null) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return request<PaginatedHistory>(
    `/sessions/history/conversation/${conversationType}/${conversationId}${qs ? `?${qs}` : ""}`,
  );
}

export interface SearchResult extends HistoryMessage {
  index: number;
}

/** Search within this group or single chat’s durable transcript only. */
export function searchConversationHistory(
  conversationId: string,
  conversationType: "group" | "single",
  q: string,
) {
  const params = new URLSearchParams({ q });
  return request<{ results: SearchResult[]; total: number }>(
    `/sessions/history/conversation/${conversationType}/${conversationId}/search?${params}`,
  );
}

export function getSessions(scope?: {
  groupId?: string;
  singleChatId?: string;
}) {
  const params = new URLSearchParams();
  if (scope?.groupId) params.set("groupId", scope.groupId);
  if (scope?.singleChatId) params.set("singleChatId", scope.singleChatId);
  const qs = params.toString();
  return request<Session[]>(`/sessions${qs ? `?${qs}` : ""}`);
}

export function createSession(opts?: {
  title?: string;
  groupId?: string;
  singleChatId?: string;
}) {
  return request<{ ok: true }>("/sessions", {
    method: "POST",
    body: JSON.stringify({
      title: opts?.title,
      groupId: opts?.groupId,
      singleChatId: opts?.singleChatId,
    }),
  });
}

// ─── Single Chat Management ──────────────────────────────────────────────────

export function deleteSingleChat(id: string) {
  return request<{ cleared: boolean }>(`/sessions/single-chats/${id}`, {
    method: "DELETE",
  });
}

// ─── Group Members ────────────────────────────────────────────────────────────

export interface GroupMemberInfo {
  userId: number;
  displayName: string | null;
}

export function getGroupMembers(groupId: string) {
  return request<GroupMemberInfo[]>(`/sessions/groups/${groupId}/members`);
}

// ─── Chat ────────────────────────────────────────────────────────────────────

/** HTTP 202 — agent work accepted; reply arrives on Socket.IO (`chat:reply`). */
export interface ChatAccepted {
  requestId: string;
  status: "accepted";
}

export async function sendMessage(
  message: string,
  requestId: string,
  scope?: {
    groupId?: string;
    singleChatId?: string;
    agentId?: string;
    mentionsAgent?: boolean;
  },
): Promise<ChatAccepted> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message,
      requestId,
      ...(scope?.groupId ? { groupId: scope.groupId } : {}),
      ...(scope?.singleChatId ? { singleChatId: scope.singleChatId } : {}),
      ...(scope?.agentId ? { agentId: scope.agentId } : {}),
      ...(scope?.mentionsAgent != null
        ? { mentionsAgent: scope.mentionsAgent }
        : {}),
    }),
  });

  if (res.status === 202) {
    return res.json() as Promise<ChatAccepted>;
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Request failed (${res.status})`,
    );
  }

  throw new Error(`Expected 202 Accepted, got ${res.status}`);
}

// ─── Notifications ───────────────────────────────────────────────────────────

/** Returns a map of conversationId → unread count. */
export function getUnreadCounts() {
  return request<Record<string, number>>("/notifications/unread");
}

// ─── Admin ───────────────────────────────────────────────────────────────────

export interface AdminUser {
  id: number;
  displayName: string | null;
  userIdentity: Record<string, unknown> | null;
  role: string;
  roleId: string | null;
  createdAt: string;
}

export interface AdminRole {
  id: string;
  name: string;
}

export interface AgentMcpServerLink {
  mcpServerId: number;
  active: boolean;
}

export interface AgentSkillLink {
  skillId: number;
  active: boolean;
}

export interface AgentToolLink {
  toolId: number;
  active: boolean;
}

export type AgentType = "primary" | "system" | "external";

export interface AdminAgent {
  id: string;
  type: AgentType;
  definition: string;
  /** Optional display name (system prompt, @mention label in groups, list_agents). */
  agentName: string | null;
  /** Short description shown when listing system agents (used by list_system_agents tool). */
  description: string | null;
  coreInstructions: string | null;
  /** Persona traits (tone, etc.) — rendered as "Your Characteristics" in the agent context. */
  characteristics: Record<string, unknown> | null;
  /** Number of groups using this agent (an agent may back multiple groups). */
  groupCount: number;
  editable: boolean;
  /** When true, this agent is locked and cannot be configured from the admin UI. */
  isLocked: boolean;
  /** The user who created this agent (null for legacy/seeded agents). */
  createdByUserId: number | null;
  /** Active MCP server IDs (backward compat). */
  mcpServerIds: number[];
  /** All MCP server assignments with active status. */
  mcpServerLinks: AgentMcpServerLink[];
  /** The LLM model assigned to this agent (references models.id). */
  modelId: string | null;
  /** Active skill IDs (backward compat). */
  skillIds?: number[];
  /** All skill assignments with active status. */
  skillLinks: AgentSkillLink[];
  /** Active tool IDs (backward compat). */
  toolIds?: number[];
  /** All tool assignments with active status. */
  toolLinks: AgentToolLink[];
  createdAt: string;
}

export interface AdminMcpServer {
  id: number;
  name: string;
  transport: string;
  command: string;
  args: string[];
  env?: Record<string, string> | null;
}

export interface AdminTool {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  category: string | null;
}

export interface AdminSkill {
  id: number;
  name: string;
  slug: string | null;
  description: string | null;
  skillText: string;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminGroup {
  id: string;
  name: string;
  agentId: string;
  createdAt: string;
}

export interface AdminGroupMember {
  id: string;
  userId: number;
  createdAt: string;
}

export interface AdminRepository {
  id: string;
  projectId: string;
  name: string;
  url: string;
  defaultBranch: string;
  architectureOverview: string | null;
  localPath: string | null;
  setupInstructions: string | null;
  agentName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminCronJob {
  id: string;
  agentId: string;
  organizationId: string;
  createdByUserId: number | null;
  name: string;
  prompt: string;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: "success" | "failed" | "enqueued" | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminProject {
  id: string;
  name: string;
  description: string | null;
  userId: number;
  architectureOverview: string | null;
  techStack: string | null;
  repositories: AdminRepository[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminWebSearchCandidate {
  id: string;
  slug: string | null;
  agentName: string | null;
  description: string | null;
  modelSlug: string | null;
}

export interface AdminOrganization {
  id: string;
  name: string;
  /** Always a string — empty when the admin hasn't filled it in. */
  summary: string;
}

export interface AdminWebSearchStatus {
  activeChoice: WebSearchChoice;
  activeAgentId: string;
  candidates: {
    gemini: AdminWebSearchCandidate | null;
    tavily: AdminWebSearchCandidate | null;
  };
}

export const admin = {
  getRoles: () => request<AdminRole[]>("/admin/roles"),
  getUsers: () => request<AdminUser[]>("/admin/users"),
  getAgents: () => request<AdminAgent[]>("/admin/agents"),
  getMcpServers: () => request<AdminMcpServer[]>("/admin/mcp-servers"),
  getSkills: () => request<AdminSkill[]>("/admin/skills"),
  getTools: () =>
    request<AdminTool[]>("/admin/tools"),
  createAgent: (data: {
    definition?: string;
    agentName?: string | null;
    description?: string | null;
    coreInstructions?: string;
    characteristics?: Record<string, unknown> | null;
    mcpServerIds?: number[];
    modelId?: string | null;
    skillIds?: number[];
    toolIds?: number[];
    type?: AgentType;
  }) =>
    request<AdminAgent>("/admin/agents", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateAgent: (
    id: string,
    data: {
      definition?: string;
      agentName?: string | null;
      description?: string | null;
      coreInstructions?: string;
      characteristics?: Record<string, unknown> | null;
      mcpServerIds?: number[];
      mcpServerLinks?: AgentMcpServerLink[];
      modelId?: string | null;
      skillIds?: number[];
      skillLinks?: AgentSkillLink[];
      toolIds?: number[];
      toolLinks?: AgentToolLink[];
    },
  ) =>
    request<AdminAgent>(`/admin/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  updateUser: (
    id: number,
    data: {
      displayName?: string;
      userIdentity?: Record<string, unknown>;
      roleId?: string;
    },
  ) =>
    request<AdminUser>(`/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  getGroups: () => request<AdminGroup[]>("/admin/groups"),
  createGroup: (name: string, agentId: string, memberUserIds: number[]) =>
    request<AdminGroup>("/admin/groups", {
      method: "POST",
      body: JSON.stringify({ name, agentId, memberUserIds }),
    }),
  renameGroup: (groupId: string, name: string) =>
    request<AdminGroup>(`/admin/groups/${groupId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  deleteGroup: (groupId: string) =>
    request<{ deleted: boolean }>(`/admin/groups/${groupId}`, {
      method: "DELETE",
    }),
  getGroupMembers: (groupId: string) =>
    request<AdminGroupMember[]>(`/admin/groups/${groupId}/members`),
  addGroupMember: (groupId: string, userId: number) =>
    request<AdminGroupMember>(`/admin/groups/${groupId}/members`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),
  removeGroupMember: (groupId: string, userId: number) =>
    request<{ deleted: number }>(`/admin/groups/${groupId}/members/${userId}`, {
      method: "DELETE",
    }),
  getVendors: () =>
    request<{ id: string; name: string; slug: string }[]>("/admin/vendors"),
  getModels: () => request<ConversationModelInfo[]>("/admin/models"),

  // ── Per-org vendor API keys (super_admin only) ────────────────────────────
  // Keys are scoped to the caller's organization — the backend pulls the
  // organizationId from the JWT, so these endpoints can never touch another
  // org's credentials regardless of what the client sends.
  getVendorApiKeys: () =>
    request<
      {
        vendorId: string;
        vendorName: string;
        vendorSlug: string;
        hasApiKey: boolean;
        masked: string | null;
        updatedAt: string | null;
      }[]
    >("/admin/vendor-api-keys"),
  setVendorApiKey: (vendorId: string, apiKey: string) =>
    request<{
      vendorId: string;
      vendorName: string;
      vendorSlug: string;
      hasApiKey: boolean;
      masked: string;
    }>(`/admin/vendor-api-keys/${vendorId}`, {
      method: "PUT",
      body: JSON.stringify({ apiKey }),
    }),
  deleteVendorApiKey: (vendorId: string) =>
    request<{ vendorId: string; vendorName: string; vendorSlug: string; hasApiKey: false }>(
      `/admin/vendor-api-keys/${vendorId}`,
      { method: "DELETE" },
    ),

  // ── Projects & Repositories ───────────────────────────────────────────────
  getProjects: () => request<AdminProject[]>("/admin/projects"),
  getRemoteBranches: (repoName: string) =>
    request<string[]>(`/admin/projects/remote-branches?repo=${encodeURIComponent(repoName)}`),
  setupProject: (data: {
    project: { name: string; description?: string; architectureOverview?: string; techStack?: string };
    repositories: {
      name: string;
      branch: string;
      generateArchitecture: boolean;
      architectureOverview?: string;
      setupInstructions?: string;
    }[];
  }) =>
    request<{ project: AdminProject; repoResults: { name: string; ok: boolean; error?: string; archWarning?: string; pendingArchitecture?: boolean; repositoryId?: string }[] }>(
      "/admin/projects/setup",
      { method: "POST", body: JSON.stringify(data) },
    ),
  updateProject: (
    id: string,
    data: {
      name?: string;
      description?: string | null;
      architectureOverview?: string | null;
      techStack?: string | null;
    },
  ) =>
    request<AdminProject>(`/admin/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteProject: (id: string) =>
    request<{ deleted: boolean }>(`/admin/projects/${id}`, { method: "DELETE" }),
  addRepository: (
    projectId: string,
    data: {
      name: string;
      branch: string;
      generateArchitecture?: boolean;
      architectureOverview?: string;
      setupInstructions?: string;
    },
  ) =>
    request<{ repository: AdminRepository; pendingArchitecture?: boolean }>(
      `/admin/projects/${projectId}/repositories`,
      { method: "POST", body: JSON.stringify(data) },
    ),
  updateRepository: (
    repoId: string,
    data: {
      name?: string;
      url?: string;
      defaultBranch?: string;
      architectureOverview?: string | null;
      localPath?: string | null;
      setupInstructions?: string | null;
      agentName?: string | null;
    },
  ) =>
    request<AdminRepository>(`/admin/projects/repositories/${repoId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteRepository: (repoId: string) =>
    request<{ deleted: boolean }>(`/admin/projects/repositories/${repoId}`, {
      method: "DELETE",
    }),
  cloneRepository: (repoId: string) =>
    request<AdminRepository>(`/admin/projects/repositories/${repoId}/clone`, {
      method: "POST",
    }),
  getRepositoryBranches: (repoId: string) =>
    request<string[]>(`/admin/projects/repositories/${repoId}/branches`),
  setRepositoryBranch: (repoId: string, branch: string) =>
    request<AdminRepository>(`/admin/projects/repositories/${repoId}/branch`, {
      method: "PATCH",
      body: JSON.stringify({ branch }),
    }),
  generateArchitecture: (repoId: string) =>
    request<AdminRepository>(`/admin/projects/repositories/${repoId}/generate-architecture`, {
      method: "POST",
    }),

  // ── Agent Cron Jobs ─────────────────────────────────────────────────────
  getAgentCronJobs: (agentId: string) =>
    request<AdminCronJob[]>(`/admin/agents/${agentId}/cron-jobs`),
  createAgentCronJob: (
    agentId: string,
    data: {
      name: string;
      prompt: string;
      cronExpression: string;
      timezone?: string;
      enabled?: boolean;
    },
  ) =>
    request<AdminCronJob>(`/admin/agents/${agentId}/cron-jobs`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateCronJob: (
    id: string,
    data: {
      name?: string;
      prompt?: string;
      cronExpression?: string;
      timezone?: string;
      enabled?: boolean;
    },
  ) =>
    request<AdminCronJob>(`/admin/cron-jobs/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteCronJob: (id: string) =>
    request<{ deleted: boolean }>(`/admin/cron-jobs/${id}`, {
      method: "DELETE",
    }),

  // ── Organization (free-text summary injected into every system prompt) ─
  getOrganization: () =>
    request<AdminOrganization>("/admin/organization"),
  setOrganizationSummary: (summary: string) =>
    request<AdminOrganization>("/admin/organization/summary", {
      method: "PATCH",
      body: JSON.stringify({ summary }),
    }),

  // ── Web search agent (per-org active pick) ─────────────────────────────
  getWebSearchAgent: () =>
    request<AdminWebSearchStatus>("/admin/web-search-agent"),
  setWebSearchAgent: (choice: WebSearchChoice) =>
    request<AdminWebSearchStatus>("/admin/web-search-agent", {
      method: "PATCH",
      body: JSON.stringify({ choice }),
    }),

  // ── Roundtables ─────────────────────────────────────────────────────────
  getRoundtables: () =>
    request<RoundtableSummary[]>("/admin/roundtables"),
  getRoundtable: (id: string) =>
    request<RoundtableDetail>(`/admin/roundtables/${id}`),
  createRoundtable: (data: {
    topic: string;
    agentIds: string[];
    maxTurnsPerAgent?: number;
    groupId?: string | null;
    singleChatId?: string | null;
    /** Legacy flag — kept for back-compat, prefer `participantUserIds`. */
    includeUser?: boolean;
    /** User IDs (any number of them) that should participate with their own turn. */
    participantUserIds?: number[];
  }) =>
    request<{ id: string; threadId: string; status: string }>("/admin/roundtables", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  stopRoundtable: (id: string) =>
    request<{ ok: boolean }>(`/admin/roundtables/${id}/stop`, {
      method: "POST",
    }),
  submitRoundtableUserTurn: (id: string, content: string) =>
    request<{ ok: boolean }>(`/admin/roundtables/${id}/user-turn`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),

  // ── Agent ↔ user Google scope grants (super_admin only) ──────────────────
  /** Users in the caller's org who have signed in with Google. */
  getGoogleUsers: () =>
    request<
      { id: number; displayName: string | null; userName: string; lastLoginAt: string | null }[]
    >("/admin/google-users"),
  /** All scope grants for one agent, grouped by subject user. */
  getAgentUserScopes: (agentId: string) =>
    request<{ subjectUserId: number; scopes: GoogleScope[] }[]>(
      `/admin/agents/${agentId}/user-scopes`,
    ),
  grantAgentUserScope: (agentId: string, subjectUserId: number, scope: GoogleScope) =>
    request<{ id: string }>(`/admin/agents/${agentId}/user-scopes`, {
      method: "POST",
      body: JSON.stringify({ subjectUserId, scope }),
    }),
  revokeAgentUserScope: (agentId: string, subjectUserId: number, scope: GoogleScope) =>
    request<{ removed: number }>(`/admin/agents/${agentId}/user-scopes`, {
      method: "DELETE",
      body: JSON.stringify({ subjectUserId, scope }),
    }),
};

export type GoogleScope =
  | "calendar.read"
  | "calendar.write"
  | "drive.read"
  | "drive.write"
  | "gmail.read"
  | "gmail.send";

export const ALL_GOOGLE_SCOPES: GoogleScope[] = [
  "calendar.read",
  "calendar.write",
  "drive.read",
  "drive.write",
  "gmail.read",
  "gmail.send",
];

// ── Roundtable types ──────────────────────────────────────────────────────

export interface RoundtableSummary {
  id: string;
  topic: string;
  status: "pending" | "running" | "waiting_for_user" | "completed" | "failed";
  maxTurnsPerAgent: number;
  currentRound: number;
  includeUser: boolean;
  createdAt: string;
}

export interface RoundtableAgentInfo {
  id: string;
  agentId: string;
  turnOrder: number;
  turnsCompleted: number;
  agentName: string;
}

export interface RoundtableUserInfo {
  id: string;
  userId: number;
  turnOrder: number;
  turnsCompleted: number;
  displayName: string;
}

export interface RoundtableMessageInfo {
  id: string;
  /** Null when this row is a user contribution. */
  agentId: string | null;
  /** Non-null when this row is a user contribution. */
  userId?: number | null;
  senderType?: "agent" | "user";
  agentName: string;
  displayName?: string | null;
  roundNumber: number;
  content: string;
  createdAt: string;
}

export interface RoundtableDetail extends RoundtableSummary {
  threadId: string;
  agents: RoundtableAgentInfo[];
  users: RoundtableUserInfo[];
  messages: RoundtableMessageInfo[];
  /** Final summary — populated once the roundtable transitions to "completed". */
  summary: string | null;
  summaryGeneratedAt: string | null;
}

// ─── In-app notifications ────────────────────────────────────────────────

export type InAppNotificationType =
  | "roundtable_invite"
  | "roundtable_turn"
  | "roundtable_completed";

export interface InAppNotification {
  id: string;
  type: InAppNotificationType;
  title: string;
  body: string | null;
  link: string | null;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export interface InAppNotificationList {
  items: InAppNotification[];
  unreadCount: number;
}

export function listInAppNotifications() {
  return request<InAppNotificationList>("/in-app-notifications");
}

export function markInAppNotificationRead(id: string) {
  return request<InAppNotification>(`/in-app-notifications/${id}/read`, {
    method: "POST",
  });
}

export function markAllInAppNotificationsRead() {
  return request<{ updated: number }>("/in-app-notifications/read-all", {
    method: "POST",
  });
}
