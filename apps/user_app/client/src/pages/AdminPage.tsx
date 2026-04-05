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
  Cpu,
  Plus,
  Trash2,
  Save,
  X,
  HelpCircle,
  Loader2,
  CheckCircle2,
  AlertCircle,
  KeyRound,
} from "lucide-react";
import {
  admin,
  type AdminUser,
  type AdminAgent,
  type AdminRole,
  type ConversationModelInfo,
} from "../api";
import { VendorIcon } from "../components/VendorModelBadge";
import UserCard from "../components/UserCard";
import AgentCard from "../components/AgentCard";
import ModelSelector from "../components/ModelSelector";
import VendorSelector from "../components/VendorSelector";
import RoleSelector from "../components/RoleSelector";

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

  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [models, setModels] = useState<ConversationModelInfo[]>([]);
  const [vendors, setVendors] = useState<
    { id: string; name: string; slug: string; hasApiKey: boolean }[]
  >([]);
  const [vendorApiKeys, setVendorApiKeys] = useState<Record<string, string>>({});
  const [savingKeyVendorId, setSavingKeyVendorId] = useState<string | null>(null);

  const [newAgentDefinition, setNewAgentDefinition] = useState("");
  const [newAgentDisplayName, setNewAgentDisplayName] = useState("");
  const [newAgentInstructions, setNewAgentInstructions] = useState("");
  const [newAgentCharacteristics, setNewAgentCharacteristics] = useState("");
  const [newAgentModelId, setNewAgentModelId] = useState<string | null>(null);
  const [newModelVendorId, setNewModelVendorId] = useState("");
  const [newModelName, setNewModelName] = useState("");
  const [newModelSlug, setNewModelSlug] = useState("");

  // ── Add Person form ────────────────────────────────────────────────────
  const [newPersonFirstName, setNewPersonFirstName] = useState("");
  const [newPersonLastName, setNewPersonLastName] = useState("");
  const [newPersonEmail, setNewPersonEmail] = useState("");
  const [newPersonIsUser, setNewPersonIsUser] = useState(false);
  const [newPersonUserName, setNewPersonUserName] = useState("");
  const [newPersonPassword, setNewPersonPassword] = useState("");
  const [newPersonRoleId, setNewPersonRoleId] = useState<string>("");
  const [newPersonIsEmployee, setNewPersonIsEmployee] = useState(false);
  const [newPersonJiraId, setNewPersonJiraId] = useState("");
  const [creatingPerson, setCreatingPerson] = useState(false);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    if (user && user.role !== "admin" && user.role !== "super_admin") navigate("/", { replace: true });
  }, [user, navigate]);

  const reload = useCallback(async () => {
    const results = await Promise.allSettled([
      admin.getUsers(),
      admin.getAgents(),
      admin.getModels(),
      admin.getVendors(),
      admin.getRoles(),
    ]);
    const labels = ["users", "agents", "models", "vendors", "roles"] as const;
    const failed: string[] = [];
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        failed.push(labels[i]);
        console.error(`[AdminPage] ${labels[i]} fetch failed:`, r.reason);
      }
    });
    if (results[0].status === "fulfilled") setUsers(results[0].value);
    if (results[1].status === "fulfilled") setAgents(results[1].value);
    if (results[2].status === "fulfilled") setModels(results[2].value);
    if (results[3].status === "fulfilled") {
      const v = results[3].value;
      setVendors(v);
      if (v.length > 0 && !newModelVendorId) setNewModelVendorId(v[0].id);
    }
    if (results[4].status === "fulfilled") setRoles(results[4].value);
    if (failed.length > 0) {
      setError(`Failed to load: ${failed.join(", ")}`);
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
        agentName: newAgentDisplayName.trim() || null,
        coreInstructions: newAgentInstructions.trim() || undefined,
        characteristics,
        modelId: newAgentModelId,
      });
      setNewAgentDefinition("");
      setNewAgentDisplayName("");
      setNewAgentInstructions("");
      setNewAgentCharacteristics("");
      setNewAgentModelId(null);
      flash("Agent created.");
      await reload();
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

  function canSubmitPerson(): boolean {
    if (!newPersonIsUser && !newPersonIsEmployee) return false;
    if (newPersonIsUser) {
      if (!newPersonUserName.trim() || !newPersonPassword.trim()) return false;
    }
    return true;
  }

  async function handleCreatePerson() {
    if (!canSubmitPerson()) return;
    setError("");
    setCreatingPerson(true);
    try {
      await admin.createPerson({
        firstName: newPersonFirstName.trim() || null,
        lastName: newPersonLastName.trim() || null,
        email: newPersonEmail.trim() || null,
        user: newPersonIsUser
          ? {
              userName: newPersonUserName.trim(),
              password: newPersonPassword,
              roleId: newPersonRoleId || null,
            }
          : null,
        employee: newPersonIsEmployee
          ? {
              jiraIdNumber: newPersonJiraId.trim() || null,
            }
          : null,
      });
      // Reset form
      setNewPersonFirstName("");
      setNewPersonLastName("");
      setNewPersonEmail("");
      setNewPersonIsUser(false);
      setNewPersonUserName("");
      setNewPersonPassword("");
      setNewPersonRoleId("");
      setNewPersonIsEmployee(false);
      setNewPersonJiraId("");
      flash("Person created.");
      await reload();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreatingPerson(false);
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

  function flash(msg: string) {
    setSuccess(msg);
    setTimeout(() => setSuccess(""), 3000);
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
              Manage agents and users
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
          <div className="relative z-10 w-full min-w-0 rounded-2xl border border-gray-200/60 bg-white/80 p-4 sm:p-6 shadow-glass backdrop-blur-sm">
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
              <div>
                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  Display name <span className="font-normal normal-case text-gray-400">(optional)</span>
                </label>
                <input
                  type="text"
                  value={newAgentDisplayName}
                  onChange={(e) => setNewAgentDisplayName(e.target.value)}
                  placeholder='System prompt (“Your name is …”)'
                  maxLength={120}
                  className={inputClass}
                />
                <p className={`mt-1 text-[10px] text-right ${newAgentDisplayName.length >= 120 ? "text-red-400" : "text-gray-400"}`}>{newAgentDisplayName.length}/120</p>
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
              {/* Model selection */}
              <div>
                <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  LLM Model
                </label>
                <ModelSelector
                  currentModel={models.find((m) => m.id === newAgentModelId) ?? null}
                  onModelChanged={(m) => setNewAgentModelId(m?.id ?? null)}
                  compact
                />
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

            <div className="space-y-2.5">
              {agents.map((a) => (
                <AgentCard key={a.id} agent={a} currentUserId={user!.id} currentUserRole={user!.role} allModels={models} onSaved={reload} />
              ))}
            </div>
          </div>

          {/* People */}
          <div className="w-full min-w-0 rounded-2xl border border-gray-200/60 bg-white/80 p-4 sm:p-6 shadow-glass backdrop-blur-sm">
            <h2 className="mb-5 flex items-center gap-2.5 text-sm font-bold text-gray-900">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-cyan-600 text-white shadow-sm">
                <Users2 className="h-4 w-4" />
              </div>
              People
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                {users.length}
              </span>
            </h2>

            {/* Add Person form */}
            <div className="mb-5 space-y-3 rounded-xl border border-dashed border-gray-200 bg-gray-50/50 p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Add new person</p>

              {/* Base person fields */}
              <div className="grid w-full min-w-0 grid-cols-1 gap-2.5 sm:[grid-template-columns:repeat(2,minmax(0,1fr))] [&>*]:min-w-0">
                <div>
                  <label className="mb-1 block text-[10px] font-medium text-gray-500">First name</label>
                  <input
                    type="text"
                    value={newPersonFirstName}
                    onChange={(e) => setNewPersonFirstName(e.target.value)}
                    placeholder="e.g. Jane"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-medium text-gray-500">Last name</label>
                  <input
                    type="text"
                    value={newPersonLastName}
                    onChange={(e) => setNewPersonLastName(e.target.value)}
                    placeholder="e.g. Doe"
                    className={inputClass}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="mb-1 block text-[10px] font-medium text-gray-500">Email</label>
                  <input
                    type="email"
                    value={newPersonEmail}
                    onChange={(e) => setNewPersonEmail(e.target.value)}
                    placeholder="e.g. jane@company.com"
                    className={inputClass}
                  />
                </div>
              </div>

              {/* Role toggles */}
              <div className="flex flex-wrap gap-2 pt-1">
                <label
                  className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-[11px] font-medium transition-all duration-150 ${
                    newPersonIsUser
                      ? "border-indigo-200 bg-indigo-50 text-indigo-700 shadow-sm"
                      : "border-gray-200 bg-white text-gray-500 hover:border-gray-300"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    checked={newPersonIsUser}
                    onChange={(e) => setNewPersonIsUser(e.target.checked)}
                  />
                  Is user (can log in)
                </label>
                <label
                  className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-[11px] font-medium transition-all duration-150 ${
                    newPersonIsEmployee
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700 shadow-sm"
                      : "border-gray-200 bg-white text-gray-500 hover:border-gray-300"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                    checked={newPersonIsEmployee}
                    onChange={(e) => setNewPersonIsEmployee(e.target.checked)}
                  />
                  Is employee (company staff)
                </label>
              </div>

              {/* User-only fields */}
              {newPersonIsUser && (
                <div className="space-y-2.5 rounded-xl border border-indigo-100 bg-indigo-50/40 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-500">User fields</p>
                  <div className="grid w-full min-w-0 grid-cols-1 gap-2.5 sm:[grid-template-columns:repeat(2,minmax(0,1fr))] [&>*]:min-w-0">
                    <div>
                      <label className="mb-1 block text-[10px] font-medium text-gray-500">Username</label>
                      <input
                        type="text"
                        value={newPersonUserName}
                        onChange={(e) => setNewPersonUserName(e.target.value)}
                        placeholder="lowercase letters, digits, underscore"
                        className={inputClass + " font-mono text-xs"}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[10px] font-medium text-gray-500">Password</label>
                      <input
                        type="password"
                        value={newPersonPassword}
                        onChange={(e) => setNewPersonPassword(e.target.value)}
                        placeholder="at least 8 characters"
                        className={inputClass}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="mb-1 block text-[10px] font-medium text-gray-500">Role</label>
                      <RoleSelector
                        roles={roles}
                        currentRoleId={newPersonRoleId}
                        onRoleChanged={setNewPersonRoleId}
                        compact
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Employee-only fields */}
              {newPersonIsEmployee && (
                <div className="space-y-2.5 rounded-xl border border-emerald-100 bg-emerald-50/40 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600">Employee fields</p>
                  <div>
                    <label className="mb-1 block text-[10px] font-medium text-gray-500">Jira ID</label>
                    <input
                      type="text"
                      value={newPersonJiraId}
                      onChange={(e) => setNewPersonJiraId(e.target.value)}
                      placeholder="e.g. 1234567"
                      className={inputClass + " font-mono text-xs"}
                    />
                  </div>
                </div>
              )}

              {!newPersonIsUser && !newPersonIsEmployee && (
                <p className="text-[11px] italic text-gray-400">
                  Select at least one role (user or employee) to enable submission.
                </p>
              )}

              <button
                onClick={handleCreatePerson}
                disabled={!canSubmitPerson() || creatingPerson}
                className={btnPrimary}
              >
                {creatingPerson ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                {creatingPerson ? "Creating..." : "Add Person"}
              </button>
            </div>

            <div className="max-h-[500px] overflow-y-auto space-y-2.5">
              {users.map((u) => (
                <UserCard key={u.id} u={u} roles={roles} currentUserRole={user?.role ?? "user"} onSaved={reload} />
              ))}
            </div>
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

            <div className="mb-5 grid w-full min-w-0 grid-cols-1 items-end gap-2.5 sm:[grid-template-columns:repeat(2,minmax(0,1fr))] lg:[grid-template-columns:repeat(4,minmax(0,1fr))] [&>*]:min-w-0">
              <div className="group">
                <label className="mb-1 flex items-center gap-1 text-[10px] font-medium text-gray-500">
                  Vendor
                  <span className="relative cursor-help">
                    <HelpCircle className="h-3 w-3 text-gray-300 transition hover:text-gray-500" />
                    <span className="pointer-events-none absolute bottom-full left-0 z-50 mb-2 w-56 rounded-xl border border-gray-200/80 bg-white/95 p-3 text-[11px] text-gray-600 opacity-0 shadow-glass-lg backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                      <strong>Vendor</strong> is the LLM provider (OpenAI, Anthropic, Google, …) this model belongs to.
                    </span>
                  </span>
                </label>
                <VendorSelector
                  vendors={vendors}
                  currentVendorId={newModelVendorId}
                  onVendorChanged={setNewModelVendorId}
                  compact
                />
              </div>
              <div className="group">
                <label className="mb-1 flex items-center gap-1 text-[10px] font-medium text-gray-500">
                  Display name
                  <span className="relative cursor-help">
                    <HelpCircle className="h-3 w-3 text-gray-300 transition hover:text-gray-500" />
                    <span className="pointer-events-none absolute bottom-full left-0 z-50 mb-2 w-56 rounded-xl border border-gray-200/80 bg-white/95 p-3 text-[11px] text-gray-600 opacity-0 shadow-glass-lg backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                      <strong>Name</strong> is what users see in the UI (e.g.
                      "GPT-4o Mini", "Gemini 3.1").
                    </span>
                  </span>
                </label>
                <input
                  type="text"
                  value={newModelName}
                  onChange={(e) => setNewModelName(e.target.value)}
                  placeholder="e.g. GPT-4o Mini"
                  className={inputClass}
                />
              </div>
              <div className="group">
                <label className="mb-1 flex items-center gap-1 text-[10px] font-medium text-gray-500">
                  API slug
                  <span className="relative cursor-help">
                    <HelpCircle className="h-3 w-3 text-gray-300 transition hover:text-gray-500" />
                    <span className="pointer-events-none absolute bottom-full left-0 z-50 mb-2 w-64 rounded-xl border border-gray-200/80 bg-white/95 p-3 text-[11px] text-gray-600 opacity-0 shadow-glass-lg backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                      <strong>Slug</strong> is the exact model ID sent to the
                      vendor API (e.g. "gpt-4o-mini", "claude-sonnet-4-6").
                      Must be unique and match the provider's model identifier.
                    </span>
                  </span>
                </label>
                <input
                  type="text"
                  value={newModelSlug}
                  onChange={(e) => setNewModelSlug(e.target.value)}
                  placeholder="e.g. gpt-4o-mini"
                  className={inputClass + " font-mono text-xs"}
                />
              </div>
              <button
                onClick={handleCreateModel}
                disabled={
                  !newModelVendorId ||
                  !newModelName.trim() ||
                  !newModelSlug.trim()
                }
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-40"
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
