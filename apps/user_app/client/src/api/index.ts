const BASE = "/claw/api";

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

export interface LoginResponse {
  token: string;
  user: { id: string; displayName: string | null; userIdentity: Record<string, unknown> | null; role: string };
  conversations: Conversations;
}

export function login(userName: string, password: string) {
  return request<LoginResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ userName, password }),
  });
}

export interface RegisterData {
  userName: string;
  displayName: string;
  password: string;
  userIdentity?: {
    role?: string;
    department?: string;
    timezone?: string;
    location?: string;
  };
}

export function register(data: RegisterData) {
  return request<LoginResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export interface MeResponse {
  id: string;
  displayName: string | null;
  role: string;
  conversations: Conversations;
}

export function getMe() {
  return request<MeResponse>("/auth/me");
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export interface Session {
  threadId: string;
  userId: string | null;
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
}

export interface PaginatedHistory {
  messages: HistoryMessage[];
  total: number;
}

export function getHistory(
  threadId: string,
  opts?: { limit?: number; offset?: number },
) {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.offset != null) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return request<PaginatedHistory>(`/sessions/history/${threadId}${qs ? `?${qs}` : ""}`);
}

export interface SearchResult extends HistoryMessage {
  index: number;
}

export function searchHistory(threadId: string, q: string) {
  const params = new URLSearchParams({ q });
  return request<{ results: SearchResult[]; total: number }>(
    `/sessions/history/${threadId}/search?${params}`,
  );
}

export function getSessions(scope?: { groupId?: string; singleChatId?: string }) {
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
  return request<Session>("/sessions", {
    method: "POST",
    body: JSON.stringify({
      title: opts?.title,
      groupId: opts?.groupId,
      singleChatId: opts?.singleChatId,
    }),
  });
}

// ─── Single Chat Management ──────────────────────────────────────────────────

export interface AgentListItem {
  id: string;
  definition: string | null;
}

export function getAgentsList() {
  return request<AgentListItem[]>("/sessions/agents");
}

export function createSingleChat(agentId: string) {
  return request<SingleChatConversation>("/sessions/single-chats", {
    method: "POST",
    body: JSON.stringify({ agentId }),
  });
}

export function deleteSingleChat(id: string) {
  return request<{ deleted: boolean }>(`/sessions/single-chats/${id}`, {
    method: "DELETE",
  });
}

// ─── Group Members ────────────────────────────────────────────────────────────

export interface GroupMemberInfo {
  userId: string;
  displayName: string | null;
}

export function getGroupMembers(groupId: string) {
  return request<GroupMemberInfo[]>(`/sessions/groups/${groupId}/members`);
}

// ─── Chat ────────────────────────────────────────────────────────────────────

/** HTTP 202 — agent work accepted; reply arrives on Socket.IO (`chat:reply`). */
export interface ChatAccepted {
  requestId: string;
  threadId: string;
  status: "accepted";
}

export async function sendMessage(
  threadId: string,
  message: string,
  requestId: string,
  scope?: { groupId?: string; singleChatId?: string; agentId?: string; mentionsAgent?: boolean },
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
      threadId,
      message,
      requestId,
      ...(scope?.groupId ? { groupId: scope.groupId } : {}),
      ...(scope?.singleChatId ? { singleChatId: scope.singleChatId } : {}),
      ...(scope?.agentId ? { agentId: scope.agentId } : {}),
      ...(scope?.mentionsAgent != null ? { mentionsAgent: scope.mentionsAgent } : {}),
    }),
  });

  if (res.status === 202) {
    return res.json() as Promise<ChatAccepted>;
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
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
  id: string;
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

export interface AdminAgent {
  id: string;
  definition: string | null;
  coreInstructions: string | null;
  singleChatId: string | null;
  groupId: string | null;
  createdAt: string;
}

export interface AdminGroup {
  id: string;
  name: string;
  agentId: string;
  createdAt: string;
}

export interface AdminGroupMember {
  id: string;
  userId: string;
  createdAt: string;
}

export const admin = {
  getRoles: () => request<AdminRole[]>("/admin/roles"),
  getUsers: () => request<AdminUser[]>("/admin/users"),
  getAgents: () => request<AdminAgent[]>("/admin/agents"),
  createAgent: (data: { definition?: string; coreInstructions?: string }) =>
    request<AdminAgent>("/admin/agents", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateAgent: (id: string, data: { definition?: string; coreInstructions?: string }) =>
    request<AdminAgent>(`/admin/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  updateUser: (id: string, data: { displayName?: string; userIdentity?: Record<string, unknown>; roleId?: string }) =>
    request<AdminUser>(`/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  getGroups: () => request<AdminGroup[]>("/admin/groups"),
  createGroup: (name: string, agentId: string, memberUserIds: string[]) =>
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
    request<{ deleted: boolean }>(`/admin/groups/${groupId}`, { method: "DELETE" }),
  getGroupMembers: (groupId: string) =>
    request<AdminGroupMember[]>(`/admin/groups/${groupId}/members`),
  addGroupMember: (groupId: string, userId: string) =>
    request<AdminGroupMember>(`/admin/groups/${groupId}/members`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),
  removeGroupMember: (groupId: string, userId: string) =>
    request<{ deleted: number }>(`/admin/groups/${groupId}/members/${userId}`, {
      method: "DELETE",
    }),
  getVendors: () =>
    request<{ id: string; name: string; slug: string; hasApiKey: boolean }[]>("/admin/vendors"),
  setVendorApiKey: (vendorId: string, apiKey: string) =>
    request<{ id: string; name: string; slug: string; hasApiKey: boolean }>(
      `/admin/vendors/${vendorId}/api-key`,
      { method: "PATCH", body: JSON.stringify({ apiKey }) },
    ),
  getModels: () =>
    request<ConversationModelInfo[]>("/admin/models"),
  createModel: (data: { vendorId: string; name: string; slug: string }) =>
    request<ConversationModelInfo>("/admin/models", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteModel: (id: string) =>
    request<{ deleted: boolean }>(`/admin/models/${id}`, { method: "DELETE" }),
  setSingleChatModel: (singleChatId: string, modelId: string) =>
    request<unknown>(`/admin/single-chats/${singleChatId}/model`, {
      method: "PATCH",
      body: JSON.stringify({ modelId }),
    }),
  setGroupModel: (groupId: string, modelId: string) =>
    request<unknown>(`/admin/groups/${groupId}/model`, {
      method: "PATCH",
      body: JSON.stringify({ modelId }),
    }),
};
