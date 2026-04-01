import { useState, useEffect, useCallback, useRef } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Container from "@mui/material/Container";
import { useAuth } from "../context/AuthContext";
import { useNavigate } from "react-router-dom";
import { getChatSocket } from "../sockets/chatSocket";
import { useToast } from "../components/Toast";
import {
  ArrowLeft,
  LogOut,
  Bot,
  Users2,
  FolderOpen,
  UserPlus,
  Cpu,
  Plus,
  Pencil,
  Trash2,
  Save,
  X,
  HelpCircle,
  Loader2,
  CheckCircle2,
  AlertCircle,
  KeyRound,
  Plug,
  Terminal,
} from "lucide-react";
import {
  admin,
  type AdminUser,
  type AdminAgent,
  type AdminGroup,
  type AdminGroupMember,
  type AdminRole,
  type AdminMcpServer,
  type ConversationModelInfo,
} from "../api";
import { VendorIcon } from "../components/VendorModelBadge";
import UserCard from "../components/UserCard";
import AgentCard from "../components/AgentCard";

export function stringifyAgentCharacteristics(
  c: Record<string, unknown> | null | undefined,
): string {
  if (!c || Object.keys(c).length === 0) return "";
  return JSON.stringify(c, null, 2);
}

export function formatUserIdentityPreview(
  identity: Record<string, unknown> | null | undefined,
): string {
  if (!identity || Object.keys(identity).length === 0) return "";
  try {
    return JSON.stringify(identity, null, 2);
  } catch {
    return String(identity);
  }
}



export default function AdminPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [agents, setAgents] = useState<AdminAgent[]>([]);
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<AdminGroup | null>(null);
  const [groupMembers, setGroupMembers] = useState<AdminGroupMember[]>([]);

  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [models, setModels] = useState<ConversationModelInfo[]>([]);
  const [vendors, setVendors] = useState<
    { id: string; name: string; slug: string; hasApiKey: boolean }[]
  >([]);
  const [vendorApiKeys, setVendorApiKeys] = useState<Record<string, string>>({});
  const [savingKeyVendorId, setSavingKeyVendorId] = useState<string | null>(null);

  const [mcpServers, setMcpServers] = useState<AdminMcpServer[]>([]);
  const [newAgentDefinition, setNewAgentDefinition] = useState("");
  const [newAgentInstructions, setNewAgentInstructions] = useState("");
  const [newAgentCharacteristics, setNewAgentCharacteristics] = useState("");
  const [newAgentMcpServerIds, setNewAgentMcpServerIds] = useState<number[]>([]);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupAgentId, setNewGroupAgentId] = useState("");
  const [newGroupMembers, setNewGroupMembers] = useState<number[]>([]);
  const [addMemberUserId, setAddMemberUserId] = useState("");
  const [newModelVendorId, setNewModelVendorId] = useState("");
  const [newModelName, setNewModelName] = useState("");
  const [newModelSlug, setNewModelSlug] = useState("");
  const [agentDropdownOpen, setAgentDropdownOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");

  const [newMcpName, setNewMcpName] = useState("");
  const [newMcpTransport, setNewMcpTransport] = useState("stdio");
  const [newMcpCommand, setNewMcpCommand] = useState("");
  const [newMcpArgs, setNewMcpArgs] = useState("");
  const [newMcpEnv, setNewMcpEnv] = useState("");
  const [creatingMcp, setCreatingMcp] = useState(false);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    if (user && user.role !== "admin" && user.role !== "super_admin") navigate("/", { replace: true });
  }, [user, navigate]);

  const reload = useCallback(async () => {
    try {
      const [u, a, g, m, v, r, mcp] = await Promise.all([
        admin.getUsers(),
        admin.getAgents(),
        admin.getGroups(),
        admin.getModels(),
        admin.getVendors(),
        admin.getRoles(),
        admin.getMcpServers(),
      ]);
      setUsers(u);
      setAgents(a);
      setGroups(g);
      setModels(m);
      setVendors(v);
      setRoles(r);
      setMcpServers(mcp);
      if (a.length > 0 && !newGroupAgentId) setNewGroupAgentId(a[0].id);
      if (v.length > 0 && !newModelVendorId) setNewModelVendorId(v[0].id);
    } catch {
      setError("Failed to load data.");
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Listen for admin changes from other admins and auto-refresh
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) return;
    const socket = getChatSocket(token);

    const onAdminChange = (data: { type: string; message: string; actorId?: number }) => {
      if (data.actorId === user?.id) return;
      toast(data.message, "info");
      reloadRef.current();
    };

    socket.on("admin:change", onAdminChange);
    return () => { socket.off("admin:change", onAdminChange); };
  }, [user?.id]);

  useEffect(() => {
    if (!selectedGroup) {
      setGroupMembers([]);
      return;
    }
    admin
      .getGroupMembers(selectedGroup.id)
      .then(setGroupMembers)
      .catch(() => {});
  }, [selectedGroup?.id]);

  async function handleCreateAgent() {
    if (
      !newAgentDefinition.trim() &&
      !newAgentInstructions.trim() &&
      !newAgentCharacteristics.trim()
    ) {
      return;
    }
    let characteristics: Record<string, unknown> | undefined;
    const chTrim = newAgentCharacteristics.trim();
    if (chTrim) {
      try {
        const parsed = JSON.parse(chTrim) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          setError("Characteristics must be a JSON object.");
          return;
        }
        characteristics = parsed as Record<string, unknown>;
      } catch {
        setError("Invalid JSON in characteristics.");
        return;
      }
    }
    setError("");
    try {
      await admin.createAgent({
        definition: newAgentDefinition.trim() || undefined,
        coreInstructions: newAgentInstructions.trim() || undefined,
        characteristics,
        mcpServerIds: newAgentMcpServerIds.length > 0 ? newAgentMcpServerIds : undefined,
      });
      setNewAgentDefinition("");
      setNewAgentInstructions("");
      setNewAgentCharacteristics("");
      setNewAgentMcpServerIds([]);
      flash("Agent created.");
      await reload();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleCreateMcpServer() {
    if (!newMcpName.trim() || !newMcpCommand.trim()) return;

    // Parse args: comma-separated string to array
    const args = newMcpArgs.trim()
      ? newMcpArgs.split(",").map((a) => a.trim()).filter(Boolean)
      : [];

    // Parse env: optional JSON object
    let env: Record<string, string> | undefined;
    if (newMcpEnv.trim()) {
      try {
        const parsed = JSON.parse(newMcpEnv.trim());
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          setError("Environment must be a JSON object.");
          return;
        }
        env = parsed as Record<string, string>;
      } catch {
        setError("Invalid JSON in environment variables.");
        return;
      }
    }

    setError("");
    setCreatingMcp(true);
    try {
      await admin.createMcpServer({
        name: newMcpName.trim(),
        transport: newMcpTransport.trim() || "stdio",
        command: newMcpCommand.trim(),
        args,
        env,
      });
      setNewMcpName("");
      setNewMcpTransport("stdio");
      setNewMcpCommand("");
      setNewMcpArgs("");
      setNewMcpEnv("");
      flash("MCP server created.");
      await reload();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreatingMcp(false);
    }
  }

  function toggleGroupMember(userId: number) {
    setNewGroupMembers((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  }

  async function handleCreateGroup() {
    if (!newGroupName.trim() || !newGroupAgentId) return;
    if (newGroupMembers.length === 0) {
      setError("You must add at least one user to the group.");
      return;
    }
    setError("");
    try {
      await admin.createGroup(newGroupName.trim(), newGroupAgentId, newGroupMembers);
      setNewGroupName("");
      setNewGroupMembers([]);
      flash("Group created.");
      await reload();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleAddMember() {
    if (!selectedGroup || !addMemberUserId) return;
    setError("");
    try {
      await admin.addGroupMember(selectedGroup.id, Number(addMemberUserId));
      setAddMemberUserId("");
      flash("Member added.");
      const m = await admin.getGroupMembers(selectedGroup.id);
      setGroupMembers(m);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleRemoveMember(userId: number) {
    if (!selectedGroup) return;
    try {
      await admin.removeGroupMember(selectedGroup.id, userId);
      const m = await admin.getGroupMembers(selectedGroup.id);
      setGroupMembers(m);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleCreateModel() {
    if (!newModelVendorId || !newModelName.trim() || !newModelSlug.trim())
      return;
    setError("");
    try {
      await admin.createModel({
        vendorId: newModelVendorId,
        name: newModelName.trim(),
        slug: newModelSlug.trim(),
      });
      setNewModelName("");
      setNewModelSlug("");
      flash("Model created.");
      await reload();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleDeleteModel(id: string) {
    setError("");
    try {
      await admin.deleteModel(id);
      flash("Model deleted.");
      await reload();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleSaveApiKey(vendorId: string) {
    const key = vendorApiKeys[vendorId];
    if (!key?.trim()) return;
    setSavingKeyVendorId(vendorId);
    setError("");
    try {
      await admin.setVendorApiKey(vendorId, key.trim());
      setVendorApiKeys((prev) => ({ ...prev, [vendorId]: "" }));
      flash("API key saved.");
      await reload();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSavingKeyVendorId(null);
    }
  }

  const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null);

  async function handleDeleteGroup(groupId: string) {
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    if (!window.confirm(`Delete group "${group.name}"? This will remove all threads, messages, and memory for this group. The agent will become available for reuse. This cannot be undone.`)) return;
    setDeletingGroupId(groupId);
    setError("");
    try {
      await admin.deleteGroup(groupId);
      if (selectedGroup?.id === groupId) setSelectedGroup(null);
      flash("Group deleted.");
      await reload();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDeletingGroupId(null);
    }
  }

  async function handleRenameGroup() {
    if (!editingGroupId || !editingGroupName.trim()) return;
    try {
      await admin.renameGroup(editingGroupId, editingGroupName.trim());
      setEditingGroupId(null);
      flash("Group renamed.");
      await reload();
    } catch (err: any) {
      setError(err.message);
    }
  }

  function flash(msg: string) {
    setSuccess(msg);
    setTimeout(() => setSuccess(""), 3000);
  }

  function getUserName(id: number) {
    return users.find((x) => x.id === id)?.displayName || String(id);
  }

  const inputClass =
    "w-full rounded-xl border border-gray-200 bg-gray-50/80 px-4 py-2.5 text-sm transition-all duration-200 focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-500/10";
  const btnPrimary =
    "inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:shadow-md hover:shadow-indigo-200/50 active:scale-[0.98] disabled:opacity-50 disabled:shadow-none";

  if (!user || user.role !== "admin" && user.role !== "super_admin") return null;

  return (
    <Stack
      component="main"
      className="min-h-screen w-full bg-gradient-to-br from-slate-50 via-white to-indigo-50/30"
    >
      {/* Single content column: max width + horizontal padding so nothing exceeds the viewport */}
      <Container
        maxWidth={false}
        disableGutters
        className="mx-auto box-border w-full min-w-0 max-w-6xl px-4 py-5 sm:px-6 sm:py-7 lg:px-8 lg:py-8"
      >
        <Stack
          component="header"
          direction="row"
          className="sticky top-0 z-10 -mx-4 mb-6 min-w-0 items-center justify-between gap-3 border-b border-gray-200/60 bg-white/90 px-4 py-3 backdrop-blur-xl sm:-mx-6 sm:mb-8 sm:px-6 sm:py-4 lg:-mx-8 lg:px-8"
        >
          <div className="min-w-0 pr-2">
            <h1 className="text-base sm:text-lg font-bold text-gray-900 tracking-tight">
              Admin Panel
            </h1>
            <p className="text-[10px] sm:text-xs text-gray-400">
              Manage agents, groups, and users
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2.5">
            <button
              onClick={() => navigate("/")}
              className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 px-2.5 py-2 sm:px-3.5 text-sm font-medium text-gray-700 transition-all duration-200 hover:bg-gray-50 hover:shadow-sm active:scale-[0.98]"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Back to Chat</span>
            </button>
            <button
              onClick={logout}
              className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 px-2.5 py-2 sm:px-3.5 text-sm font-medium text-gray-700 transition-all duration-200 hover:bg-red-50 hover:text-red-600 hover:border-red-200 active:scale-[0.98]"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          </div>
        </Stack>

        <Stack component="section" className="w-full min-w-0 space-y-6 sm:space-y-8">
        {error && (
          <div className="flex items-center gap-2.5 sm:gap-3 rounded-2xl bg-red-50 px-4 py-3 sm:px-5 sm:py-4 text-sm text-red-700 ring-1 ring-red-100 animate-slide-up">
            <AlertCircle className="h-5 w-5 flex-shrink-0 text-red-500" />
            <span className="flex-1 min-w-0 break-words">{error}</span>
            <button
              onClick={() => setError("")}
              className="rounded-lg p-1 hover:bg-red-100 transition"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        {success && (
          <div className="flex items-center gap-2.5 sm:gap-3 rounded-2xl bg-emerald-50 px-4 py-3 sm:px-5 sm:py-4 text-sm text-emerald-700 ring-1 ring-emerald-100 animate-slide-up">
            <CheckCircle2 className="h-5 w-5 flex-shrink-0 text-emerald-500" />
            {success}
          </div>
        )}

        <Box className="grid w-full min-w-0 grid-cols-1 gap-5 sm:gap-6 lg:gap-8 lg:[grid-template-columns:repeat(2,minmax(0,1fr))] [&>*]:min-w-0">
          {/* Agents */}
          <div className="w-full min-w-0 rounded-2xl border border-gray-200/60 bg-white/80 p-4 sm:p-6 shadow-glass backdrop-blur-sm">
            <h2 className="mb-5 flex items-center gap-2.5 text-sm font-bold text-gray-900">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-sm">
                <Bot className="h-4 w-4" />
              </div>
              Agents
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                {agents.length}
              </span>
            </h2>

            <div className="mb-5 space-y-2.5">
              <div>
                <input
                  type="text"
                  value={newAgentDefinition}
                  onChange={(e) => setNewAgentDefinition(e.target.value)}
                  placeholder='Role label, e.g. "AI Default Agent"'
                  maxLength={30}
                  className={inputClass}
                />
                <p className={`mt-1 text-[10px] text-right ${newAgentDefinition.length >= 30 ? "text-red-400" : "text-gray-400"}`}>{newAgentDefinition.length}/30</p>
              </div>
              <textarea
                value={newAgentInstructions}
                onChange={(e) => setNewAgentInstructions(e.target.value)}
                placeholder="Detailed instructions for the agent..."
                rows={3}
                className={inputClass}
              />
              <textarea
                value={newAgentCharacteristics}
                onChange={(e) => setNewAgentCharacteristics(e.target.value)}
                placeholder='Characteristics (optional JSON), e.g. {"tone": "..."}'
                rows={3}
                className={inputClass + " font-mono text-xs"}
              />
              {/* MCP Server selection */}
              <div>
                <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  MCP Servers
                  <span className="ml-1 normal-case font-normal text-gray-400">(tools available to this agent)</span>
                </label>
                <div className="flex flex-wrap gap-1.5 rounded-xl border border-gray-200 bg-gray-50/80 p-2.5 min-h-[42px]">
                  {mcpServers.map((s) => {
                    const selected = newAgentMcpServerIds.includes(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() =>
                          setNewAgentMcpServerIds((prev) =>
                            selected ? prev.filter((id) => id !== s.id) : [...prev, s.id],
                          )
                        }
                        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-150 ${
                          selected
                            ? "bg-violet-100 text-violet-700 ring-1 ring-violet-200 shadow-sm"
                            : "bg-white text-gray-500 ring-1 ring-gray-200 hover:bg-gray-100 hover:text-gray-700"
                        }`}
                      >
                        <span
                          className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
                            selected
                              ? "bg-violet-500 text-white"
                              : "bg-gray-200 text-gray-500"
                          }`}
                        >
                          {s.name.charAt(0).toUpperCase()}
                        </span>
                        {s.name}
                        {selected && <X className="h-3 w-3 ml-0.5" />}
                      </button>
                    );
                  })}
                  {mcpServers.length === 0 && (
                    <p className="text-xs text-gray-400 py-1">No MCP servers configured.</p>
                  )}
                </div>
              </div>
              <button
                onClick={handleCreateAgent}
                disabled={
                  !newAgentDefinition.trim() &&
                  !newAgentInstructions.trim() &&
                  !newAgentCharacteristics.trim()
                }
                className={btnPrimary}
              >
                <Plus className="h-4 w-4" />
                Create Agent
              </button>
            </div>

            <div className="max-h-[400px] overflow-y-auto space-y-2.5">
              {agents.map((a) => (
                <AgentCard key={a.id} agent={a} currentUserId={user!.id} currentUserRole={user!.role} allMcpServers={mcpServers} onSaved={reload} />
              ))}
            </div>
          </div>

          {/* Users */}
          <div className="w-full min-w-0 rounded-2xl border border-gray-200/60 bg-white/80 p-4 sm:p-6 shadow-glass backdrop-blur-sm">
            <h2 className="mb-5 flex items-center gap-2.5 text-sm font-bold text-gray-900">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-cyan-600 text-white shadow-sm">
                <Users2 className="h-4 w-4" />
              </div>
              Users
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                {users.length}
              </span>
            </h2>
            <div className="max-h-[500px] overflow-y-auto space-y-2.5">
              {users.map((u) => (
                <UserCard key={u.id} u={u} roles={roles} currentUserRole={user?.role ?? "user"} onSaved={reload} />
              ))}
            </div>
          </div>

          {/* Groups */}
          <div className="w-full min-w-0 rounded-2xl border border-gray-200/60 bg-white/80 p-4 sm:p-6 shadow-glass backdrop-blur-sm">
            <h2 className="mb-5 flex items-center gap-2.5 text-sm font-bold text-gray-900">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-sm">
                <FolderOpen className="h-4 w-4" />
              </div>
              Groups
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                {groups.length}
              </span>
            </h2>
            <div className="mb-5 space-y-2.5">
              <input
                type="text"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="Group name"
                className={inputClass}
              />
              {/* Agent selector */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setAgentDropdownOpen(!agentDropdownOpen)}
                  className={`${inputClass} flex items-center justify-between text-left`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-sm">
                      <Bot className="h-3.5 w-3.5" />
                    </div>
                    <span className="truncate text-sm text-gray-900">
                      {agents.find((a) => a.id === newGroupAgentId)?.definition ||
                        (newGroupAgentId ? newGroupAgentId.slice(0, 8) : "Select an agent...")}
                    </span>
                  </div>
                  <svg
                    className={`h-4 w-4 flex-shrink-0 text-gray-400 transition-transform duration-200 ${agentDropdownOpen ? "rotate-180" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {agentDropdownOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setAgentDropdownOpen(false)}
                    />
                    <div className="absolute left-0 right-0 z-20 mt-1.5 max-h-52 overflow-y-auto rounded-xl border border-gray-200/80 bg-white/95 p-1 shadow-glass-lg backdrop-blur-xl">
                      {agents.map((a) => {
                          const isSelected = a.id === newGroupAgentId;
                          return (
                            <button
                              key={a.id}
                              type="button"
                              onClick={() => {
                                setNewGroupAgentId(a.id);
                                setAgentDropdownOpen(false);
                              }}
                              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-all duration-150 ${
                                isSelected
                                  ? "bg-indigo-50 ring-1 ring-indigo-100"
                                  : "hover:bg-gray-50"
                              }`}
                            >
                              <div
                                className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg shadow-sm ${
                                  isSelected
                                    ? "bg-gradient-to-br from-violet-500 to-indigo-600 text-white"
                                    : "bg-gray-100 text-gray-500"
                                }`}
                              >
                                <Bot className="h-3.5 w-3.5" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className={`text-sm truncate ${isSelected ? "font-semibold text-indigo-700" : "font-medium text-gray-900"}`}>
                                  {a.definition || "Unnamed Agent"}
                                </p>
                                <p className="font-mono text-[10px] text-gray-400 truncate">
                                  {a.id}
                                </p>
                              </div>
                              {isSelected && (
                                <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-indigo-600" />
                              )}
                            </button>
                          );
                        })}
                      {agents.length === 0 && (
                        <p className="py-3 text-center text-xs text-gray-400">
                          No agents yet. Create an agent first.
                        </p>
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* Member selection */}
              <div>
                <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  Members <span className="text-red-400">*</span>
                  <span className="ml-1 normal-case font-normal text-gray-400">(you are added automatically)</span>
                </label>
                <div className="flex flex-wrap gap-1.5 rounded-xl border border-gray-200 bg-gray-50/80 p-2.5 min-h-[42px]">
                  {users
                    .filter((u) => u.id !== user?.id)
                    .map((u) => {
                      const selected = newGroupMembers.includes(u.id);
                      return (
                        <button
                          key={u.id}
                          type="button"
                          onClick={() => toggleGroupMember(u.id)}
                          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-150 ${
                            selected
                              ? "bg-indigo-100 text-indigo-700 ring-1 ring-indigo-200 shadow-sm"
                              : "bg-white text-gray-500 ring-1 ring-gray-200 hover:bg-gray-100 hover:text-gray-700"
                          }`}
                        >
                          <span
                            className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
                              selected
                                ? "bg-indigo-500 text-white"
                                : "bg-gray-200 text-gray-500"
                            }`}
                          >
                            {String(u.displayName || u.id).charAt(0).toUpperCase()}
                          </span>
                          {u.displayName || u.id}
                          {selected && <X className="h-3 w-3 ml-0.5" />}
                        </button>
                      );
                    })}
                  {users.filter((u) => u.id !== user?.id).length === 0 && (
                    <p className="text-xs text-gray-400 py-1">No users available.</p>
                  )}
                </div>
                {newGroupMembers.length === 0 && newGroupName.trim() && (
                  <p className="mt-1 text-[10px] text-amber-600 font-medium">
                    Select at least one user to create the group.
                  </p>
                )}
              </div>

              <button
                onClick={handleCreateGroup}
                disabled={!newGroupName.trim() || !newGroupAgentId || newGroupMembers.length === 0}
                className={btnPrimary}
              >
                <Plus className="h-4 w-4" />
                Create Group
              </button>
            </div>
            <div className="max-h-48 overflow-y-auto space-y-1.5">
              {groups.map((g) => (
                <div
                  key={g.id}
                  className={`flex min-w-0 items-center rounded-xl px-3.5 py-2.5 text-sm transition-all duration-150 ${
                    selectedGroup?.id === g.id
                      ? "bg-gradient-to-r from-indigo-50 to-blue-50 font-medium text-indigo-700 ring-1 ring-indigo-100"
                      : "bg-gray-50 text-gray-700 hover:bg-white hover:shadow-sm hover:ring-1 hover:ring-gray-100"
                  }`}
                >
                  {editingGroupId === g.id ? (
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <input
                        autoFocus
                        value={editingGroupName}
                        onChange={(e) => setEditingGroupName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleRenameGroup();
                          if (e.key === "Escape") setEditingGroupId(null);
                        }}
                        className="flex-1 rounded-lg border border-gray-200 px-2.5 py-1 text-xs focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/10"
                      />
                      <button
                        onClick={handleRenameGroup}
                        className="text-[10px] font-semibold text-indigo-600 hover:text-indigo-800"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingGroupId(null)}
                        className="text-[10px] text-gray-400 hover:text-gray-600"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        onClick={() => setSelectedGroup(g)}
                        className="min-w-0 flex-1 text-left truncate"
                      >
                        {g.name}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingGroupId(g.id);
                          setEditingGroupName(g.name);
                        }}
                        className="ml-1 rounded-lg p-1.5 text-gray-400 hover:bg-gray-200 hover:text-gray-600 transition"
                        title="Rename group"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteGroup(g.id);
                        }}
                        disabled={deletingGroupId === g.id}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 transition disabled:opacity-50"
                        title="Delete group"
                      >
                        {deletingGroupId === g.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Trash2 className="h-3 w-3" />
                        )}
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Group Members */}
          <div className="w-full min-w-0 rounded-2xl border border-gray-200/60 bg-white/80 p-4 sm:p-6 shadow-glass backdrop-blur-sm">
            <h2 className="mb-5 flex items-center gap-2.5 text-sm font-bold text-gray-900">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-sm">
                <UserPlus className="h-4 w-4" />
              </div>
              {selectedGroup
                ? `Members of "${selectedGroup.name}"`
                : <>
                    <span className="hidden sm:inline">Select a group</span>
                    <span className="sm:hidden">Select a group from the Groups box</span>
                  </>}
            </h2>
            {selectedGroup ? (
              <>
                <div className="mb-4 flex flex-col sm:flex-row gap-2 sm:gap-2.5">
                  <select
                    value={addMemberUserId}
                    onChange={(e) => setAddMemberUserId(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">Select a user...</option>
                    {users
                      .filter(
                        (u) => !groupMembers.some((m) => m.userId === u.id),
                      )
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.displayName || u.id}
                        </option>
                      ))}
                  </select>
                  <button
                    onClick={handleAddMember}
                    disabled={!addMemberUserId}
                    className={btnPrimary + " whitespace-nowrap justify-center sm:w-auto"}
                  >
                    <Plus className="h-4 w-4" />
                    Add
                  </button>
                </div>
                <div className="space-y-1.5">
                  {groupMembers.length === 0 && (
                    <p className="py-6 text-center text-xs text-gray-400">
                      No members yet.
                    </p>
                  )}
                  {groupMembers.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between gap-2 rounded-xl bg-gray-50 px-3 py-2.5 sm:px-3.5 transition hover:bg-white hover:shadow-sm hover:ring-1 hover:ring-gray-100"
                    >
                      <span className="text-sm text-gray-700 truncate min-w-0">
                        {getUserName(m.userId)}
                        <span className="ml-1.5 font-mono text-[10px] text-gray-400 hidden sm:inline">
                          ({m.userId})
                        </span>
                      </span>
                      {m.userId !== 1 && (
                        <button
                          onClick={() => handleRemoveMember(m.userId)}
                          className="inline-flex flex-shrink-0 items-center gap-1 rounded-lg bg-red-50 px-2 py-1 sm:px-2.5 text-[11px] font-medium text-red-600 transition hover:bg-red-100"
                        >
                          <Trash2 className="h-3 w-3" />
                          <span className="hidden sm:inline">Remove</span>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center py-10">
                <FolderOpen className="h-8 w-8 text-gray-200 mb-2" />
                <p className="text-xs text-gray-400">
                  <span className="hidden sm:inline">Click a group on the left to manage its members.</span>
                  <span className="sm:hidden">Select a group above to manage its members.</span>
                </p>
              </div>
            )}
          </div>

          {/* API Keys */}
          <div className="w-full min-w-0 lg:col-span-2 rounded-2xl border border-gray-200/60 bg-white/80 p-4 sm:p-6 shadow-glass backdrop-blur-sm">
            <h2 className="mb-5 flex items-center gap-2.5 text-sm font-bold text-gray-900">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-sm">
                <KeyRound className="h-4 w-4" />
              </div>
              API Keys
            </h2>

            <div className="grid w-full min-w-0 grid-cols-1 gap-3 sm:[grid-template-columns:repeat(2,minmax(0,1fr))] lg:[grid-template-columns:repeat(3,minmax(0,1fr))] [&>*]:min-w-0">
              {vendors.map((v) => (
                <div
                  key={v.id}
                  className="min-w-0 rounded-xl border border-gray-200/60 bg-white p-4 shadow-glass transition-all duration-200"
                >
                  <div className="mb-3 flex min-w-0 items-center gap-2.5">
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-gray-200/80 bg-gray-50 text-gray-600">
                      <VendorIcon slug={v.slug} />
                    </div>
                    <span className="min-w-0 truncate text-sm font-semibold text-gray-900">{v.name}</span>
                    {v.hasApiKey ? (
                      <span className="ml-auto rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">
                        Configured
                      </span>
                    ) : (
                      <span className="ml-auto rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-500">
                        Missing
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={vendorApiKeys[v.id] ?? ""}
                      onChange={(e) =>
                        setVendorApiKeys((prev) => ({ ...prev, [v.id]: e.target.value }))
                      }
                      placeholder={v.hasApiKey ? "Enter new key to replace" : "Enter API key"}
                      className="flex-1 min-w-0 rounded-xl border border-gray-200 bg-gray-50/80 px-3 py-2 text-xs font-mono transition-all duration-200 focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-500/10"
                    />
                    <button
                      onClick={() => handleSaveApiKey(v.id)}
                      disabled={!vendorApiKeys[v.id]?.trim() || savingKeyVendorId === v.id}
                      className="flex-shrink-0 inline-flex items-center gap-1 rounded-xl bg-indigo-500 px-3 py-2 text-xs font-medium text-white shadow-sm transition hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {savingKeyVendorId === v.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* MCP Servers — super_admin only */}
          {user?.role === "super_admin" && (
          <div className="w-full min-w-0 lg:col-span-2 rounded-2xl border border-gray-200/60 bg-white/80 p-4 sm:p-6 shadow-glass backdrop-blur-sm">
            <h2 className="mb-5 flex items-center gap-2.5 text-sm font-bold text-gray-900">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-sm">
                <Plug className="h-4 w-4" />
              </div>
              MCP Servers
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                {mcpServers.length}
              </span>
            </h2>

            {/* Create form */}
            <div className="mb-5 space-y-3 rounded-xl border border-dashed border-gray-200 bg-gray-50/50 p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Add new server</p>
              <div className="grid w-full min-w-0 grid-cols-1 gap-2.5 sm:[grid-template-columns:repeat(2,minmax(0,1fr))] [&>*]:min-w-0">
                {/* Name */}
                <div className="relative group">
                  <label className="mb-1 block text-[10px] font-medium text-gray-500">Name</label>
                  <input
                    type="text"
                    value={newMcpName}
                    onChange={(e) => setNewMcpName(e.target.value)}
                    placeholder='e.g. "filesystem"'
                    className={inputClass}
                  />
                  <div className="absolute right-3 top-[26px] cursor-help">
                    <HelpCircle className="h-4 w-4 text-gray-300 transition hover:text-gray-500" />
                    <div className="pointer-events-none absolute bottom-full right-0 z-50 mb-2 w-56 rounded-xl border border-gray-200/80 bg-white/95 p-3 text-[11px] text-gray-600 opacity-0 shadow-glass-lg backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                      <strong>Name</strong> is a unique identifier for this server. It appears when assigning servers to agents (e.g. "filesystem", "github", "bash").
                    </div>
                  </div>
                </div>

                {/* Transport */}
                <div className="relative group">
                  <label className="mb-1 block text-[10px] font-medium text-gray-500">Transport</label>
                  <select
                    value={newMcpTransport}
                    onChange={(e) => setNewMcpTransport(e.target.value)}
                    className={inputClass}
                  >
                    <option value="stdio">stdio</option>
                    <option value="sse">sse</option>
                  </select>
                  <div className="absolute right-8 top-[26px] cursor-help">
                    <HelpCircle className="h-4 w-4 text-gray-300 transition hover:text-gray-500" />
                    <div className="pointer-events-none absolute bottom-full right-0 z-50 mb-2 w-60 rounded-xl border border-gray-200/80 bg-white/95 p-3 text-[11px] text-gray-600 opacity-0 shadow-glass-lg backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                      <strong>Transport</strong> defines how the agent communicates with the server. <strong>stdio</strong> launches a local process; <strong>sse</strong> connects to a remote HTTP endpoint.
                    </div>
                  </div>
                </div>

                {/* Command */}
                <div className="relative group">
                  <label className="mb-1 block text-[10px] font-medium text-gray-500">Command</label>
                  <input
                    type="text"
                    value={newMcpCommand}
                    onChange={(e) => setNewMcpCommand(e.target.value)}
                    placeholder='e.g. "npx" or "uvx"'
                    className={inputClass + " font-mono text-xs"}
                  />
                  <div className="absolute right-3 top-[26px] cursor-help">
                    <HelpCircle className="h-4 w-4 text-gray-300 transition hover:text-gray-500" />
                    <div className="pointer-events-none absolute bottom-full right-0 z-50 mb-2 w-60 rounded-xl border border-gray-200/80 bg-white/95 p-3 text-[11px] text-gray-600 opacity-0 shadow-glass-lg backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                      <strong>Command</strong> is the executable used to start the MCP server process (e.g. <code className="rounded bg-gray-100 px-1">npx</code>, <code className="rounded bg-gray-100 px-1">uvx</code>, <code className="rounded bg-gray-100 px-1">node</code>).
                    </div>
                  </div>
                </div>

                {/* Args */}
                <div className="relative group">
                  <label className="mb-1 block text-[10px] font-medium text-gray-500">Arguments</label>
                  <input
                    type="text"
                    value={newMcpArgs}
                    onChange={(e) => setNewMcpArgs(e.target.value)}
                    placeholder='Comma-separated, e.g. "-y, @modelcontextprotocol/server-filesystem, /data"'
                    className={inputClass + " font-mono text-xs"}
                  />
                  <div className="absolute right-3 top-[26px] cursor-help">
                    <HelpCircle className="h-4 w-4 text-gray-300 transition hover:text-gray-500" />
                    <div className="pointer-events-none absolute bottom-full right-0 z-50 mb-2 w-64 rounded-xl border border-gray-200/80 bg-white/95 p-3 text-[11px] text-gray-600 opacity-0 shadow-glass-lg backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                      <strong>Arguments</strong> are passed to the command as a list. Enter them separated by commas. For example: <code className="rounded bg-gray-100 px-1">-y, @modelcontextprotocol/server-filesystem, /app/data</code>
                    </div>
                  </div>
                </div>
              </div>

              {/* Env — full width */}
              <div className="relative group">
                <label className="mb-1 block text-[10px] font-medium text-gray-500">Environment Variables (optional)</label>
                <textarea
                  value={newMcpEnv}
                  onChange={(e) => setNewMcpEnv(e.target.value)}
                  placeholder={'{\n  "API_KEY": "{{MY_ENV_VAR}}"\n}'}
                  rows={3}
                  className={inputClass + " font-mono text-xs resize-y"}
                />
                <div className="absolute right-3 top-[22px] cursor-help">
                  <HelpCircle className="h-4 w-4 text-gray-300 transition hover:text-gray-500" />
                  <div className="pointer-events-none absolute bottom-full right-0 z-50 mb-2 w-72 rounded-xl border border-gray-200/80 bg-white/95 p-3 text-[11px] text-gray-600 opacity-0 shadow-glass-lg backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                    <strong>Environment variables</strong> are passed to the server process as a JSON object. Use <code className="rounded bg-gray-100 px-1">{`{{VAR_NAME}}`}</code> syntax to reference host environment variables at runtime. Leave empty if none are needed.
                  </div>
                </div>
              </div>

              <button
                onClick={handleCreateMcpServer}
                disabled={!newMcpName.trim() || !newMcpCommand.trim() || creatingMcp}
                className={btnPrimary}
              >
                {creatingMcp ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                {creatingMcp ? "Creating..." : "Add MCP Server"}
              </button>
            </div>

            {/* Existing servers list */}
            <div className="grid w-full min-w-0 grid-cols-1 gap-2.5 sm:[grid-template-columns:repeat(2,minmax(0,1fr))] lg:[grid-template-columns:repeat(3,minmax(0,1fr))] [&>*]:min-w-0">
              {mcpServers.map((s) => (
                <div
                  key={s.id}
                  className="flex min-w-0 items-start gap-3 rounded-xl border border-gray-200/60 bg-white p-3.5 shadow-glass transition-all duration-200 hover:shadow-md"
                >
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-100 to-purple-100 text-violet-600">
                    <Terminal className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900 truncate">{s.name}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-gray-400 truncate">
                      {s.command} {s.args.join(" ")}
                    </p>
                    <span className="mt-1 inline-block rounded-full bg-violet-50 px-2 py-0.5 text-[9px] font-semibold text-violet-500 uppercase">
                      {s.transport}
                    </span>
                  </div>
                </div>
              ))}
              {mcpServers.length === 0 && (
                <p className="col-span-full py-6 text-center text-xs text-gray-400">
                  No MCP servers configured yet.
                </p>
              )}
            </div>
          </div>
          )}

          {/* Models */}
          <div className="w-full min-w-0 lg:col-span-2 rounded-2xl border border-gray-200/60 bg-white/80 p-4 sm:p-6 shadow-glass backdrop-blur-sm">
            <h2 className="mb-5 flex items-center gap-2.5 text-sm font-bold text-gray-900">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-pink-500 to-rose-600 text-white shadow-sm">
                <Cpu className="h-4 w-4" />
              </div>
              Models
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                {models.length}
              </span>
            </h2>

            <div className="mb-5 grid w-full min-w-0 grid-cols-1 gap-2.5 sm:[grid-template-columns:repeat(2,minmax(0,1fr))] lg:[grid-template-columns:repeat(4,minmax(0,1fr))] [&>*]:min-w-0">
              <select
                value={newModelVendorId}
                onChange={(e) => setNewModelVendorId(e.target.value)}
                className={inputClass}
              >
                <option value="">Select vendor...</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
              <div className="relative group">
                <input
                  type="text"
                  value={newModelName}
                  onChange={(e) => setNewModelName(e.target.value)}
                  placeholder="Display name, e.g. GPT-4o Mini"
                  className={inputClass}
                />
                <div className="absolute right-3 top-1/2 -translate-y-1/2 cursor-help">
                  <HelpCircle className="h-4 w-4 text-gray-300 transition hover:text-gray-500" />
                  <div className="pointer-events-none absolute bottom-full right-0 z-50 mb-2 w-56 rounded-xl border border-gray-200/80 bg-white/95 p-3 text-[11px] text-gray-600 opacity-0 shadow-glass-lg backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                    <strong>Name</strong> is what users see in the UI (e.g.
                    "GPT-4o Mini", "Gemini 3.1").
                  </div>
                </div>
              </div>
              <div className="relative group">
                <input
                  type="text"
                  value={newModelSlug}
                  onChange={(e) => setNewModelSlug(e.target.value)}
                  placeholder="API slug, e.g. gpt-4o-mini"
                  className={inputClass + " font-mono text-xs"}
                />
                <div className="absolute right-3 top-1/2 -translate-y-1/2 cursor-help">
                  <HelpCircle className="h-4 w-4 text-gray-300 transition hover:text-gray-500" />
                  <div className="pointer-events-none absolute bottom-full right-0 z-50 mb-2 w-64 rounded-xl border border-gray-200/80 bg-white/95 p-3 text-[11px] text-gray-600 opacity-0 shadow-glass-lg backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                    <strong>Slug</strong> is the exact model ID sent to the
                    vendor API (e.g. "gpt-4o-mini", "claude-sonnet-4-6").
                    Must be unique and match the provider's model identifier.
                  </div>
                </div>
              </div>
              <button
                onClick={handleCreateModel}
                disabled={
                  !newModelVendorId ||
                  !newModelName.trim() ||
                  !newModelSlug.trim()
                }
                className={btnPrimary + " justify-center"}
              >
                <Plus className="h-4 w-4" />
                Add Model
              </button>
            </div>

            <div className="grid w-full min-w-0 grid-cols-1 gap-2.5 sm:[grid-template-columns:repeat(2,minmax(0,1fr))] lg:[grid-template-columns:repeat(3,minmax(0,1fr))] [&>*]:min-w-0">
              {models.map((m) => (
                <div
                  key={m.id}
                  className="flex min-w-0 items-center gap-2.5 sm:gap-3 rounded-xl border border-gray-200/60 bg-white p-3 sm:p-3.5 shadow-glass transition-all duration-200 hover:shadow-md"
                >
                  <div className="flex h-8 w-8 sm:h-9 sm:w-9 flex-shrink-0 items-center justify-center rounded-xl border border-gray-200/80 bg-gray-50 text-gray-600">
                    <VendorIcon slug={m.vendor?.slug ?? ""} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900 truncate">
                      {m.name}
                    </p>
                    <p className="font-mono text-[10px] text-gray-400 truncate">
                      {m.slug}
                    </p>
                  </div>
                  <span className="hidden sm:inline rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">
                    {m.vendor?.name ?? "?"}
                  </span>
                  <button
                    onClick={() => handleDeleteModel(m.id)}
                    className="flex-shrink-0 rounded-xl p-1.5 text-gray-300 transition hover:bg-red-50 hover:text-red-500"
                    title="Delete model"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </Box>
      </Stack>
      </Container>
    </Stack>
  );
}
