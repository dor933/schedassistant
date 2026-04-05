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

export interface SingleChatConversation {
  id: string;
  agentId: string;
  title: string | null;
  model: ConversationModelInfo | null;
}

export interface Conversations {
  singleChats: SingleChatConversation[];
}

export interface LoginResponse {
  token: string;
  user: {
    id: number;
    displayName: string | null;
    userIdentity: Record<string, unknown> | null;
    role: string;
  };
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
    /** Place and IANA zone together, e.g. `Israel (Asia/Jerusalem)`. */
    location?: string;
    /** @deprecated Use `location` with zone embedded. */
    timezone?: string;
  };
}

export function register(data: RegisterData) {
  return request<LoginResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export interface MeResponse {
  id: number;
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
  userId: number | null;
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
  conversationType: "single",
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

/** Search within this single chat's durable transcript only. */
export function searchConversationHistory(
  conversationId: string,
  conversationType: "single",
  q: string,
) {
  const params = new URLSearchParams({ q });
  return request<{ results: SearchResult[]; total: number }>(
    `/sessions/history/conversation/${conversationType}/${conversationId}/search?${params}`,
  );
}

export function getSessions(scope?: {
  singleChatId?: string;
}) {
  const params = new URLSearchParams();
  if (scope?.singleChatId) params.set("singleChatId", scope.singleChatId);
  const qs = params.toString();
  return request<Session[]>(`/sessions${qs ? `?${qs}` : ""}`);
}

export function createSession(opts?: {
  title?: string;
  singleChatId?: string;
}) {
  return request<{ ok: true }>("/sessions", {
    method: "POST",
    body: JSON.stringify({
      title: opts?.title,
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

export interface AdminAgent {
  id: string;
  definition: string;
  /** Optional display name (system prompt, list_agents). */
  agentName: string | null;
  coreInstructions: string | null;
  /** Persona traits (tone, etc.) — rendered as "Your Characteristics" in the agent context. */
  characteristics: Record<string, unknown> | null;
  editable: boolean;
  /** The user who created this agent (null for legacy/seeded agents). */
  createdByUserId: number | null;
  /** The LLM model assigned to this agent (references models.id). */
  modelId: string | null;
  createdAt: string;
}

export const admin = {
  getRoles: () => request<AdminRole[]>("/admin/roles"),
  getUsers: () => request<AdminUser[]>("/admin/users"),
  getAgents: () => request<AdminAgent[]>("/admin/agents"),
  createAgent: (data: {
    definition?: string;
    agentName?: string | null;
    coreInstructions?: string;
    characteristics?: Record<string, unknown> | null;
    modelId?: string | null;
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
      coreInstructions?: string;
      characteristics?: Record<string, unknown> | null;
      modelId?: string | null;
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
  createPerson: (data: {
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    user?: {
      userName: string;
      password: string;
      displayName?: string | null;
      roleId?: string | null;
    } | null;
    employee?: {
      jiraIdNumber?: string | null;
    } | null;
  }) =>
    request<{
      person: {
        id: number;
        firstName: string | null;
        lastName: string | null;
        email: string | null;
        createdAt: string;
      };
      user: {
        id: number;
        userName: string;
        displayName: string | null;
        roleId: string | null;
      } | null;
      employee: { id: number; jiraIdNumber: string | null } | null;
    }>("/admin/persons", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getVendors: () =>
    request<{ id: string; name: string; slug: string; hasApiKey: boolean }[]>(
      "/admin/vendors",
    ),
  setVendorApiKey: (vendorId: string, apiKey: string) =>
    request<{ id: string; name: string; slug: string; hasApiKey: boolean }>(
      `/admin/vendors/${vendorId}/api-key`,
      { method: "PATCH", body: JSON.stringify({ apiKey }) },
    ),
  getModels: () => request<ConversationModelInfo[]>("/admin/models"),
  createModel: (data: { vendorId: string; name: string; slug: string }) =>
    request<ConversationModelInfo>("/admin/models", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteModel: (id: string) =>
    request<{ deleted: boolean }>(`/admin/models/${id}`, { method: "DELETE" }),
};
