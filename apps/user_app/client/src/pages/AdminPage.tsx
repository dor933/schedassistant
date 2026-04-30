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
  Loader2,
  CheckCircle2,
  KeyRound,
  Plug,
  Terminal,
  Sparkles,
  GitBranch,
  FolderGit2,
  Download,
  ChevronDown,
  ChevronUp,
  Globe,
  Search,
  Building2,
  BookOpen,
  Upload,
  FileText,
  Webhook,
} from "lucide-react";
import {
  admin,
  type AdminUser,
  type AdminAgent,
  type AgentType,
  type AdminGroup,
  type AdminGroupMember,
  type AdminRole,
  type AdminMcpServer,
  type AdminSkill,
  type AdminTool,
  type AdminProject,
  type AdminRepository,
  type AdminWebSearchStatus,
  type ConversationModelInfo,
  type WebSearchChoice,
  type AdminOrganization,
  type LibraryFile,
} from "../api";
import { VendorIcon } from "../components/VendorModelBadge";
import UserCard from "../components/UserCard";
import AgentCard from "../components/AgentCard";
import ModelSelector from "../components/ModelSelector";
import GooglePermissionsSection from "../components/GooglePermissionsSection";

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

type McpFormState = {
  name: string;
  description: string;
  command: string;
  argsText: string;
  envText: string;
  scriptContent: string;
  mode: "command" | "script";
};

const emptyMcpForm: McpFormState = {
  name: "",
  description: "",
  command: "",
  argsText: "",
  envText: "",
  scriptContent: "",
  mode: "command",
};

// ─── Branch picker (compact custom dropdown with git branch icon) ────────────

function BranchPicker({
  branches,
  value,
  onChange,
  placeholder = "Select branch...",
  currentBranch,
  disabled = false,
}: {
  branches: string[];
  value: string;
  onChange: (b: string) => void;
  placeholder?: string;
  currentBranch?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-xl border border-gray-200 bg-gray-50/80 px-4 py-2.5 text-left text-sm transition-all duration-200 hover:border-indigo-300 hover:bg-white focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-500/10 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <GitBranch className="h-4 w-4 flex-shrink-0 text-indigo-400" />
        {value ? (
          <span className="flex-1 truncate font-mono text-xs font-medium text-gray-800">
            {value}
            {value === currentBranch && (
              <span className="ml-1.5 rounded-full bg-green-50 px-1.5 py-0.5 text-[9px] font-semibold text-green-600">
                current
              </span>
            )}
          </span>
        ) : (
          <span className="flex-1 truncate text-gray-400">{placeholder}</span>
        )}
        <ChevronDown
          className={`h-4 w-4 flex-shrink-0 text-gray-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && branches.length > 0 && (
        <div className="absolute left-0 top-full z-50 mt-2 max-h-64 w-full animate-scale-in overflow-y-auto rounded-2xl border border-gray-200/80 bg-white/95 p-1.5 shadow-glass-lg backdrop-blur-xl">
          {branches.map((b) => {
            const isSelected = b === value;
            const isCurrent = b === currentBranch;
            return (
              <button
                key={b}
                type="button"
                onClick={() => {
                  onChange(b);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                  isSelected ? "bg-indigo-50 ring-1 ring-indigo-100" : "hover:bg-gray-50"
                }`}
              >
                <GitBranch
                  className={`h-3.5 w-3.5 flex-shrink-0 ${
                    isSelected ? "text-indigo-500" : "text-gray-400"
                  }`}
                />
                <span
                  className={`flex-1 truncate font-mono text-xs ${
                    isSelected ? "font-semibold text-indigo-700" : "text-gray-700"
                  }`}
                >
                  {b}
                </span>
                {isCurrent && (
                  <span className="flex-shrink-0 rounded-full bg-green-50 px-2 py-0.5 text-[10px] font-semibold text-green-600">
                    current
                  </span>
                )}
                {isSelected && !isCurrent && <CheckCircle2 className="h-4 w-4 text-indigo-500" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}


export default function AdminPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [organization, setOrganization] = useState<AdminOrganization | null>(null);
  const [orgSummaryDraft, setOrgSummaryDraft] = useState("");
  const [savingOrgSummary, setSavingOrgSummary] = useState(false);
  const [libraryFiles, setLibraryFiles] = useState<LibraryFile[]>([]);
  const [uploadingLibraryFile, setUploadingLibraryFile] = useState(false);
  const [deletingLibraryFile, setDeletingLibraryFile] = useState<string | null>(null);
  const [downloadingLibraryFile, setDownloadingLibraryFile] = useState<string | null>(null);
  const libraryFileInputRef = useRef<HTMLInputElement | null>(null);
  const [agents, setAgents] = useState<AdminAgent[]>([]);
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<AdminGroup | null>(null);
  const [groupMembers, setGroupMembers] = useState<AdminGroupMember[]>([]);

  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [models, setModels] = useState<ConversationModelInfo[]>([]);
  // Per-org vendor API keys — only populated for super_admin; regular admins
  // never see the keys card. `hasApiKey` on each entry drives the
  // Configured/Missing pill in the UI.
  const [vendorApiKeys, setVendorApiKeys] = useState<
    {
      vendorId: string;
      vendorName: string;
      vendorSlug: string;
      hasApiKey: boolean;
      masked: string | null;
      updatedAt: string | null;
    }[]
  >([]);
  // System-wide Claude Code OAuth token — super_admin only. Persisted on the
  // agent_service container and inherited by every spawned `claude` CLI via
  // CLAUDE_CODE_OAUTH_TOKEN, so admins skip `su-exec agent claude /login`.
  const [claudeOauthToken, setClaudeOauthToken] = useState<{
    configured: boolean;
    masked: string | null;
    updatedAt: string | null;
  } | null>(null);
  // System-wide Codex CLI API key — super_admin only. Same lifecycle as the
  // Claude OAuth token but persisted on a sibling file under /home/agent/.codex
  // and exported as OPENAI_API_KEY so spawned `codex` CLIs authenticate
  // without `codex login` inside the container.
  const [codexApiKey, setCodexApiKey] = useState<{
    configured: boolean;
    masked: string | null;
    updatedAt: string | null;
  } | null>(null);
  // Codex ChatGPT-account login blob — sibling of codexApiKey but covers the
  // OAuth path (paste of `~/.codex/auth.json` from a workstation that ran
  // `codex login`). Codex prefers this file over the API key when both exist.
  const [codexAuthJson, setCodexAuthJson] = useState<{
    configured: boolean;
    accountIdSuffix: string | null;
    accessTokenMasked: string | null;
    hasRefreshToken: boolean;
    hasOpenaiApiKey: boolean;
    lastRefresh: string | null;
    updatedAt: string | null;
  } | null>(null);
  const [mcpServers, setMcpServers] = useState<AdminMcpServer[]>([]);
  const [mcpForm, setMcpForm] = useState<McpFormState>(emptyMcpForm);
  const [editingMcpId, setEditingMcpId] = useState<number | null>(null);
  const [mcpSaving, setMcpSaving] = useState(false);
  const [mcpDeletingId, setMcpDeletingId] = useState<number | null>(null);
  const [mcpInstallingId, setMcpInstallingId] = useState<number | null>(null);
  const [webSearchStatus, setWebSearchStatus] =
    useState<AdminWebSearchStatus | null>(null);
  const [webSearchSwitching, setWebSearchSwitching] = useState(false);
  const [newAgentDefinition, setNewAgentDefinition] = useState("");
  const [newAgentDisplayName, setNewAgentDisplayName] = useState("");
  const [newAgentDescription, setNewAgentDescription] = useState("");
  const [newAgentInstructions, setNewAgentInstructions] = useState("");
  const [newAgentCharacteristics, setNewAgentCharacteristics] = useState("");
  const [newAgentSkillIds, setNewAgentSkillIds] = useState<number[]>([]);
  const [newAgentToolIds, setNewAgentToolIds] = useState<number[]>([]);
  const [newAgentMcpServerIds, setNewAgentMcpServerIds] = useState<number[]>([]);
  const [newAgentModelId, setNewAgentModelId] = useState<string | null>(null);
  const [newAgentType, setNewAgentType] = useState<AgentType>("primary");
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupAgentId, setNewGroupAgentId] = useState("");
  const [newGroupMembers, setNewGroupMembers] = useState<number[]>([]);
  const [addMemberUserId, setAddMemberUserId] = useState("");
  // ── New local user form (super_admin only) ──────────────────────────
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [newUserUserName, setNewUserUserName] = useState("");
  const [newUserDisplayName, setNewUserDisplayName] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserRoleId, setNewUserRoleId] = useState<string>("");
  const [creatingUser, setCreatingUser] = useState(false);
  const [newUserError, setNewUserError] = useState<string | null>(null);
  const [agentDropdownOpen, setAgentDropdownOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");

  const [tools, setTools] = useState<AdminTool[]>([]);
  const [skills, setSkills] = useState<AdminSkill[]>([]);

  // ── Epic Orchestrator: Projects & Repositories ──
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [epicView, setEpicView] = useState<"list" | "wizard">("list");
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  // wizard state
  const [wizardStep, setWizardStep] = useState<1 | 2>(1);
  const [newProjName, setNewProjName] = useState("");
  const [newProjDescription, setNewProjDescription] = useState("");
  const [newProjArchitecture, setNewProjArchitecture] = useState("");
  const [newProjTechStack, setNewProjTechStack] = useState("");
  // wizard repos (client-side list, submitted all at once)
  type WizardRepo = {
    name: string;
    branch: string;
    generateArchitecture: boolean;
    architectureOverview: string;
    setupInstructions: string;
    branches: string[]; // fetched from remote
  };
  const [wizardRepos, setWizardRepos] = useState<WizardRepo[]>([]);
  // current repo being added in the wizard
  const [wizRepoName, setWizRepoName] = useState("");
  const [wizRepoBranches, setWizRepoBranches] = useState<string[]>([]);
  const [wizRepoLoadingBranches, setWizRepoLoadingBranches] = useState(false);
  const [wizRepoBranch, setWizRepoBranch] = useState("");
  const [wizRepoGenArch, setWizRepoGenArch] = useState(false);
  const [wizRepoArchitecture, setWizRepoArchitecture] = useState("");
  const [wizRepoSetupInstructions, setWizRepoSetupInstructions] = useState("");
  const [wizEditingRepoIdx, setWizEditingRepoIdx] = useState<number | null>(null);
  const [submittingProject, setSubmittingProject] = useState(false);
  // editing existing project
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editProjName, setEditProjName] = useState("");
  const [editProjDescription, setEditProjDescription] = useState("");
  const [editProjArchitecture, setEditProjArchitecture] = useState("");
  const [editProjTechStack, setEditProjTechStack] = useState("");
  const [savingProjectId, setSavingProjectId] = useState<string | null>(null);
  // editing existing repo
  const [editingRepoId, setEditingRepoId] = useState<string | null>(null);
  const [editRepoName, setEditRepoName] = useState("");
  const [editRepoArchitecture, setEditRepoArchitecture] = useState("");
  const [editRepoSetupInstructions, setEditRepoSetupInstructions] = useState("");
  const [editRepoAgentName, setEditRepoAgentName] = useState("");
  const [savingRepoId, setSavingRepoId] = useState<string | null>(null);
  // add repo to existing project
  const [addRepoProjectId, setAddRepoProjectId] = useState<string | null>(null);
  const [addRepoName, setAddRepoName] = useState("");
  const [addRepoBranches, setAddRepoBranches] = useState<string[]>([]);
  const [addRepoBranch, setAddRepoBranch] = useState("");
  const [addRepoLoadingBranches, setAddRepoLoadingBranches] = useState(false);
  const [addRepoGenArch, setAddRepoGenArch] = useState(false);
  const [addRepoArchitecture, setAddRepoArchitecture] = useState("");
  const [addRepoSetupInstructions, setAddRepoSetupInstructions] = useState("");
  const [addingRepo, setAddingRepo] = useState(false);
  // clone / branch state (for existing repos in list view)
  const [cloningRepoId, setCloningRepoId] = useState<string | null>(null);
  const [branchesRepoId, setBranchesRepoId] = useState<string | null>(null);
  const [availableBranches, setAvailableBranches] = useState<string[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [settingBranch, setSettingBranch] = useState(false);


  /** Show error toast (replaces old inline banner) */
  function setError(msg: string) {
    if (msg) toast(msg, "error");
  }

  useEffect(() => {
    if (user && user.role !== "admin" && user.role !== "super_admin") navigate("/", { replace: true });
  }, [user, navigate]);

  const reload = useCallback(async () => {
    try {
      // Vendor API keys are super_admin-only. Use .catch(() => []) so regular
      // admins don't surface the 403 as a page-level error.
      const [u, a, g, m, r, mcp, sk, tl, proj, ws, vak, org, lib, claudeTok, codexKey, codexAuth] = await Promise.all([
        admin.getUsers(),
        admin.getAgents(),
        admin.getGroups(),
        admin.getModels(),
        admin.getRoles(),
        admin.getMcpServers(),
        admin.getSkills().catch(() => [] as AdminSkill[]),
        admin.getTools().catch(() => [] as AdminTool[]),
        admin.getProjects().catch(() => [] as AdminProject[]),
        admin.getWebSearchAgent().catch(() => null),
        admin.getVendorApiKeys().catch(
          () =>
            [] as {
              vendorId: string;
              vendorName: string;
              vendorSlug: string;
              hasApiKey: boolean;
              masked: string | null;
              updatedAt: string | null;
            }[],
        ),
        admin.getOrganization().catch(() => null),
        admin.getLibraryFiles().catch(() => ({ files: [] as LibraryFile[] })),
        // super_admin-only: regular admins get a 403 here, swallow it so the
        // page still loads.
        admin.getClaudeOauthToken().catch(() => null),
        admin.getCodexApiKey().catch(() => null),
        admin.getCodexAuthJson().catch(() => null),
      ]);
      setUsers(u);
      if (org) {
        setOrganization(org);
        setOrgSummaryDraft(org.summary ?? "");
      }
      setAgents(a);
      setGroups(g);
      setModels(m);
      setRoles(r);
      setMcpServers(mcp);
      setSkills(sk);
      setTools(tl);
      setProjects(proj);
      setWebSearchStatus(ws);
      setVendorApiKeys(vak);
      setLibraryFiles(lib.files ?? []);
      setClaudeOauthToken(claudeTok);
      setCodexApiKey(codexKey);
      setCodexAuthJson(codexAuth);
      // System agents are delegated to by primary agents — they never own a
      // group / roundtable themselves. External agents are roundtable-only.
      if (!newGroupAgentId) {
        const firstPrimary = a.find((x) => x.type === "primary");
        if (firstPrimary) setNewGroupAgentId(firstPrimary.id);
      }
    } catch {
      setError("Failed to load data.");
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleSaveOrgSummary = useCallback(async () => {
    if (savingOrgSummary) return;
    setSavingOrgSummary(true);
    try {
      const next = await admin.setOrganizationSummary(orgSummaryDraft);
      setOrganization(next);
      setOrgSummaryDraft(next.summary ?? "");
      toast("Organization summary saved.", "success");
    } catch (e: any) {
      toast(e?.message ?? "Failed to save organization summary.", "error");
    } finally {
      setSavingOrgSummary(false);
    }
  }, [orgSummaryDraft, savingOrgSummary, toast]);

  const handleUploadLibraryFile = useCallback(
    async (file: File) => {
      if (uploadingLibraryFile) return;
      setUploadingLibraryFile(true);
      try {
        await admin.uploadLibraryFile(file);
        const next = await admin.getLibraryFiles();
        setLibraryFiles(next.files ?? []);
        toast(`Uploaded "${file.name}" to the library.`, "success");
      } catch (e: any) {
        toast(e?.message ?? "Failed to upload library file.", "error");
      } finally {
        setUploadingLibraryFile(false);
        if (libraryFileInputRef.current) {
          libraryFileInputRef.current.value = "";
        }
      }
    },
    [toast, uploadingLibraryFile],
  );

  const handleDeleteLibraryFile = useCallback(
    async (fileName: string) => {
      if (deletingLibraryFile) return;
      if (!window.confirm(`Remove "${fileName}" from the shared library?`)) return;
      setDeletingLibraryFile(fileName);
      try {
        await admin.deleteLibraryFile(fileName);
        setLibraryFiles((prev) => prev.filter((f) => f.fileName !== fileName));
        toast(`Deleted "${fileName}" from the library.`, "success");
      } catch (e: any) {
        toast(e?.message ?? "Failed to delete library file.", "error");
      } finally {
        setDeletingLibraryFile(null);
      }
    },
    [deletingLibraryFile, toast],
  );

  const handleDownloadLibraryFile = useCallback(
    async (fileName: string) => {
      if (downloadingLibraryFile) return;
      setDownloadingLibraryFile(fileName);
      try {
        await admin.downloadLibraryFile(fileName);
      } catch (e: any) {
        toast(e?.message ?? "Failed to download library file.", "error");
      } finally {
        setDownloadingLibraryFile(null);
      }
    },
    [downloadingLibraryFile, toast],
  );

  // Slugs of system agents that are shared by design and cannot be assigned to
  // a single primary agent (web search candidates + the dedicated Google
  // Workspace agent). Mirrors `SHARED_SYSTEM_AGENT_SLUGS` in
  // packages/types/src/index.ts — kept inline here to avoid pulling the types
  // package into the Vite client bundle for three strings. Server enforces the
  // same rule, this is purely a UX guard so the select stays disabled.
  const SHARED_SYSTEM_AGENT_SLUGS = new Set([
    "google_workspace_agent",
    "web_search",
    "web_search_tavily",
  ]);

  const handleSwitchWebSearchAgent = useCallback(
    async (choice: WebSearchChoice) => {
      if (webSearchSwitching) return;
      if (webSearchStatus?.activeChoice === choice) return;
      setWebSearchSwitching(true);
      try {
        const next = await admin.setWebSearchAgent(choice);
        setWebSearchStatus(next);
        toast(
          choice === "tavily"
            ? "Tavily is now the active web-search agent."
            : "Gemini is now the active web-search agent.",
          "success",
        );
      } catch (e: any) {
        toast(e?.message ?? "Failed to switch web-search agent.", "error");
      } finally {
        setWebSearchSwitching(false);
      }
    },
    [toast, webSearchStatus, webSearchSwitching],
  );

  // Re-assigns a system agent's owning primary agent (or clears it to make
  // the system agent shared org-wide). The PATCH endpoint enforces that the
  // owner is a primary in the same org and that the target is a system
  // agent — we just hand off the chosen value.
  const handleAssignSystemAgentOwner = useCallback(
    async (systemAgentId: string, newOwnerId: string | null) => {
      try {
        await admin.updateAgent(systemAgentId, { owningPrimaryAgentId: newOwnerId });
        await reload();
        toast(
          newOwnerId
            ? "System agent locked to the selected primary."
            : "System agent set to shared (org-wide).",
          "success",
        );
      } catch (e: any) {
        toast(e?.message ?? "Failed to update system agent owner.", "error");
      }
    },
    [reload, toast],
  );

  // Listen for admin changes from other admins and auto-refresh
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) return;
    const socket = getChatSocket(token);

    const onAdminChange = (data: { type: string; message: string; data?: any; actorId?: number }) => {
      // Architecture generation events should be handled for ALL users (including the actor)
      // since it runs in the background after project creation
      if (data.type === "repository_architecture_generated") {
        const { repositoryId, architectureOverview } = data.data ?? {};
        if (repositoryId) {
          setProjects((prev) =>
            prev.map((p) => ({
              ...p,
              repositories: p.repositories.map((r) =>
                r.id === repositoryId ? { ...r, architectureOverview } : r,
              ),
            })),
          );
        }
        toast(data.message, "success");
        return;
      }
      if (data.type === "repository_architecture_failed") {
        toast(data.message, "error");
        if (data.actorId === user?.id) return;
        reloadRef.current();
        return;
      }

      if (data.type === "organization_summary_changed") {
        const nextOrg = data.data?.organization as AdminOrganization | undefined;
        if (nextOrg) {
          setOrganization(nextOrg);
          // Only overwrite the draft if another admin changed it — don't
          // clobber what the local admin is typing.
          if (data.actorId !== user?.id) {
            setOrgSummaryDraft(nextOrg.summary ?? "");
          }
        }
        if (data.actorId === user?.id) return;
        toast(data.message, "info");
        return;
      }

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
        agentName: newAgentDisplayName.trim() || null,
        description: newAgentDescription.trim() || null,
        coreInstructions: newAgentInstructions.trim() || undefined,
        characteristics,
        modelId: newAgentModelId,
        skillIds: newAgentSkillIds.length > 0 ? newAgentSkillIds : undefined,
        toolIds: newAgentToolIds.length > 0 ? newAgentToolIds : undefined,
        mcpServerIds: newAgentMcpServerIds.length > 0 ? newAgentMcpServerIds : undefined,
        type: newAgentType,
      });
      setNewAgentDefinition("");
      setNewAgentDisplayName("");
      setNewAgentDescription("");
      setNewAgentInstructions("");
      setNewAgentCharacteristics("");
      setNewAgentSkillIds([]);
      setNewAgentToolIds([]);
      setNewAgentMcpServerIds([]);
      setNewAgentModelId(null);
      setNewAgentType("primary");
      flash("Agent created.");
      await reload();
    } catch (err: any) {
      setError(err.message);
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

  async function handleCreateUser() {
    setNewUserError(null);
    if (!newUserUserName.trim() || !newUserDisplayName.trim() || !newUserPassword) {
      setNewUserError("Username, display name, and password are required.");
      return;
    }
    setCreatingUser(true);
    try {
      await admin.createUser({
        userName: newUserUserName.trim(),
        displayName: newUserDisplayName.trim(),
        password: newUserPassword,
        roleId: newUserRoleId || null,
      });
      setNewUserUserName("");
      setNewUserDisplayName("");
      setNewUserPassword("");
      setNewUserRoleId("");
      setAddUserOpen(false);
      flash("User created.");
      await reload();
    } catch (err: any) {
      setNewUserError(err?.message ?? "Failed to create user.");
    } finally {
      setCreatingUser(false);
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

  function resetMcpForm() {
    setMcpForm(emptyMcpForm);
    setEditingMcpId(null);
  }

  function parseMcpArgs(text: string): string[] {
    return text
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  function parseMcpEnv(text: string): Record<string, string> | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("MCP env must be valid JSON.");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("MCP env must be a JSON object.");
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!key.trim() || typeof value !== "string") {
        throw new Error("MCP env values must be strings.");
      }
    }
    return parsed as Record<string, string>;
  }

  function startEditMcp(server: AdminMcpServer) {
    setEditingMcpId(server.id);
    setMcpForm({
      name: server.name,
      description: server.description ?? "",
      command: server.isScript ? "" : server.command,
      argsText: (server.args ?? []).join("\n"),
      envText: server.env ? JSON.stringify(server.env, null, 2) : "",
      scriptContent: server.scriptContent ?? "",
      mode: server.isScript ? "script" : "command",
    });
  }

  async function handleSaveMcpServer() {
    if (mcpSaving) return;
    const name = mcpForm.name.trim();
    if (!name) {
      setError("CLI MCP server name is required.");
      return;
    }

    setMcpSaving(true);
    try {
      const env = parseMcpEnv(mcpForm.envText);
      const payload: any = {
        name,
        description: mcpForm.description.trim() || null,
        transport: "stdio",
        env,
      };

      if (mcpForm.mode === "script") {
        if (!mcpForm.scriptContent.trim()) {
          setError("Custom JS script is required.");
          return;
        }
        payload.scriptContent = mcpForm.scriptContent;
      } else {
        if (!mcpForm.command.trim()) {
          setError("MCP command is required.");
          return;
        }
        payload.command = mcpForm.command.trim();
        payload.args = parseMcpArgs(mcpForm.argsText);
        const previous = mcpServers.find((s) => s.id === editingMcpId);
        if (previous?.isScript) payload.scriptContent = null;
      }

      if (editingMcpId) {
        await admin.updateMcpServer(editingMcpId, payload);
        toast("CLI MCP server updated.", "success");
      } else {
        await admin.createMcpServer(payload);
        toast("CLI MCP server created.", "success");
      }
      resetMcpForm();
      await reload();
    } catch (err: any) {
      setError(err?.message ?? "Failed to save CLI MCP server.");
    } finally {
      setMcpSaving(false);
    }
  }

  async function handleDeleteMcpServer(server: AdminMcpServer) {
    if (!window.confirm(`Delete CLI MCP server "${server.name}"?`)) return;
    setMcpDeletingId(server.id);
    try {
      await admin.deleteMcpServer(server.id);
      if (editingMcpId === server.id) resetMcpForm();
      toast("CLI MCP server deleted.", "success");
      await reload();
    } catch (err: any) {
      setError(err?.message ?? "Failed to delete CLI MCP server.");
    } finally {
      setMcpDeletingId(null);
    }
  }

  async function handleInstallMcpServer(server: AdminMcpServer) {
    setMcpInstallingId(server.id);
    try {
      await admin.installMcpServer(server.id);
      toast(`Installed "${server.name}".`, "success");
      await reload();
    } catch (err: any) {
      setError(err?.message ?? "Failed to install CLI MCP server.");
    } finally {
      setMcpInstallingId(null);
    }
  }

  function flash(msg: string) {
    toast(msg, "success");
  }

  // ── Epic Orchestrator handlers ───────────────────────────────────────────

  function resetWizard() {
    setWizardStep(1);
    setNewProjName(""); setNewProjDescription(""); setNewProjArchitecture(""); setNewProjTechStack("");
    setWizardRepos([]);
    resetWizRepoForm();
  }

  function resetWizRepoForm() {
    setWizRepoName(""); setWizRepoBranches([]); setWizRepoBranch("");
    setWizRepoGenArch(false); setWizRepoArchitecture(""); setWizRepoSetupInstructions("");
    setWizEditingRepoIdx(null);
  }

  async function handleWizFetchBranches() {
    const name = wizRepoName.trim();
    if (!name) return;
    setWizRepoLoadingBranches(true);
    setWizRepoBranches([]); setWizRepoBranch("");
    setError("");
    try {
      const branches = await admin.getRemoteBranches(name);
      setWizRepoBranches(branches);
      if (branches.includes("main")) setWizRepoBranch("main");
      else if (branches.length > 0) setWizRepoBranch(branches[0]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setWizRepoLoadingBranches(false);
    }
  }

  function handleWizAddRepo() {
    if (!wizRepoName.trim() || !wizRepoBranch) return;
    if (!wizRepoGenArch && !wizRepoArchitecture.trim()) return;
    const entry: WizardRepo = {
      name: wizRepoName.trim(),
      branch: wizRepoBranch,
      generateArchitecture: wizRepoGenArch,
      architectureOverview: wizRepoArchitecture.trim(),
      setupInstructions: wizRepoSetupInstructions.trim(),
      branches: wizRepoBranches,
    };
    if (wizEditingRepoIdx !== null) {
      setWizardRepos((prev) => prev.map((r, i) => i === wizEditingRepoIdx ? entry : r));
    } else {
      setWizardRepos((prev) => [...prev, entry]);
    }
    resetWizRepoForm();
  }

  function handleWizEditRepo(idx: number) {
    const r = wizardRepos[idx];
    setWizRepoName(r.name);
    setWizRepoBranches(r.branches);
    setWizRepoBranch(r.branch);
    setWizRepoGenArch(r.generateArchitecture);
    setWizRepoArchitecture(r.architectureOverview);
    setWizRepoSetupInstructions(r.setupInstructions);
    setWizEditingRepoIdx(idx);
  }

  function handleWizRemoveRepo(idx: number) {
    setWizardRepos((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSubmitWizard() {
    if (!newProjName.trim() || wizardRepos.length === 0) return;
    setSubmittingProject(true);
    setError("");
    try {
      const result = await admin.setupProject({
        project: {
          name: newProjName.trim(),
          description: newProjDescription.trim() || undefined,
          architectureOverview: newProjArchitecture.trim() || undefined,
          techStack: newProjTechStack.trim() || undefined,
        },
        repositories: wizardRepos.map((r) => ({
          name: r.name,
          branch: r.branch,
          generateArchitecture: r.generateArchitecture,
          architectureOverview: r.architectureOverview || undefined,
          setupInstructions: r.setupInstructions || undefined,
        })),
      });

      const pendingArch = result.repoResults.filter((r: any) => r.pendingArchitecture);
      if (pendingArch.length > 0) {
        toast(
          `Project created. Architecture is being generated for: ${pendingArch.map((r: any) => r.name).join(", ")}. You'll be notified when it's ready.`,
          "info",
        );
      } else {
        toast("Project and all repositories set up successfully.", "success");
      }

      resetWizard();
      setEpicView("list");
      await reload();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmittingProject(false);
    }
  }

  async function handleCloneRepo(repoId: string) {
    setCloningRepoId(repoId);
    setError("");
    try {
      await admin.cloneRepository(repoId);
      await reload();
      toast("Repository cloned.", "success");
      // auto-load branches after clone
      await handleLoadBranches(repoId);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCloningRepoId(null);
    }
  }

  async function handleLoadBranches(repoId: string) {
    setLoadingBranches(true);
    setBranchesRepoId(repoId);
    try {
      const branches = await admin.getRepositoryBranches(repoId);
      setAvailableBranches(branches);
    } catch (err: any) {
      setError(err.message);
      setBranchesRepoId(null);
    } finally {
      setLoadingBranches(false);
    }
  }

  async function handleSetBranch(repoId: string, branch: string) {
    setSettingBranch(true);
    setError("");
    try {
      await admin.setRepositoryBranch(repoId, branch);
      setBranchesRepoId(null);
      setAvailableBranches([]);
      await reload();
      toast(`Branch set to "${branch}".`, "success");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSettingBranch(false);
    }
  }

  function startEditProject(p: AdminProject) {
    setEditingProjectId(p.id);
    setEditProjName(p.name);
    setEditProjDescription(p.description || "");
    setEditProjArchitecture(p.architectureOverview || "");
    setEditProjTechStack(p.techStack || "");
  }

  async function handleSaveProject(projectId: string) {
    setSavingProjectId(projectId);
    setError("");
    try {
      await admin.updateProject(projectId, {
        name: editProjName.trim() || undefined,
        description: editProjDescription.trim() || null,
        architectureOverview: editProjArchitecture.trim() || null,
        techStack: editProjTechStack.trim() || null,
      });
      setEditingProjectId(null);
      await reload();
      toast("Project updated.", "success");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSavingProjectId(null);
    }
  }

  async function handleDeleteProject(projectId: string) {
    if (!window.confirm("Delete this project and all its repositories?")) return;
    try {
      await admin.deleteProject(projectId);
      await reload();
      toast("Project deleted.", "success");
    } catch (err: any) {
      setError(err.message);
    }
  }

  function startEditRepo(r: AdminRepository) {
    setEditingRepoId(r.id);
    setEditRepoName(r.name);
    setEditRepoArchitecture(r.architectureOverview || "");
    setEditRepoSetupInstructions(r.setupInstructions || "");
    setEditRepoAgentName(r.agentName || "");
  }

  async function handleSaveRepo(repoId: string) {
    setSavingRepoId(repoId);
    setError("");
    try {
      await admin.updateRepository(repoId, {
        name: editRepoName.trim() || undefined,
        architectureOverview: editRepoArchitecture.trim() || null,
        setupInstructions: editRepoSetupInstructions.trim() || null,
        agentName: editRepoAgentName.trim() || null,
      });
      setEditingRepoId(null);
      await reload();
      toast("Repository updated.", "success");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSavingRepoId(null);
    }
  }

  async function handleDeleteRepo(repoId: string) {
    if (!window.confirm("Delete this repository?")) return;
    try {
      await admin.deleteRepository(repoId);
      await reload();
      toast("Repository deleted.", "success");
    } catch (err: any) {
      setError(err.message);
    }
  }

  const [generatingArchRepoId, setGeneratingArchRepoId] = useState<string | null>(null);

  async function handleGenerateArchitecture(repoId: string) {
    setGeneratingArchRepoId(repoId);
    setError("");
    try {
      await admin.generateArchitecture(repoId);
      toast("Architecture generation started — you'll be notified when it's ready.", "info");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setGeneratingArchRepoId(null);
    }
  }

  function resetAddRepoForm() {
    setAddRepoProjectId(null);
    setAddRepoName(""); setAddRepoBranches([]); setAddRepoBranch("");
    setAddRepoGenArch(false); setAddRepoArchitecture(""); setAddRepoSetupInstructions("");
  }

  async function handleAddRepoFetchBranches() {
    const name = addRepoName.trim();
    if (!name) return;
    setAddRepoLoadingBranches(true);
    setAddRepoBranches([]); setAddRepoBranch("");
    setError("");
    try {
      const branches = await admin.getRemoteBranches(name);
      setAddRepoBranches(branches);
      if (branches.includes("main")) setAddRepoBranch("main");
      else if (branches.length > 0) setAddRepoBranch(branches[0]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAddRepoLoadingBranches(false);
    }
  }

  async function handleAddRepoSubmit() {
    if (!addRepoProjectId || !addRepoName.trim() || !addRepoBranch.trim()) return;
    setAddingRepo(true);
    setError("");
    try {
      const result = await admin.addRepository(addRepoProjectId, {
        name: addRepoName.trim(),
        branch: addRepoBranch.trim(),
        generateArchitecture: addRepoGenArch,
        architectureOverview: addRepoArchitecture.trim() || undefined,
        setupInstructions: addRepoSetupInstructions.trim() || undefined,
      });
      await reload();
      if (result.pendingArchitecture) {
        toast(`Repository added. Architecture is being generated — you'll be notified when it's ready.`, "info");
      } else {
        toast("Repository added.", "success");
      }
      resetAddRepoForm();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAddingRepo(false);
    }
  }

  function getUserName(id: number) {
    return users.find((x) => x.id === id)?.displayName || String(id);
  }

  const inputClass =
    "w-full rounded-xl border border-gray-200 bg-gray-50/80 px-4 py-2.5 text-sm transition-all duration-200 focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-500/10";
  const btnPrimary =
    "inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:shadow-md hover:shadow-indigo-200/50 active:scale-[0.98] disabled:opacity-50 disabled:shadow-none";

  const ownedMcpServers = mcpServers.filter((s) => s.organizationId !== null);
  const publicMcpServers = mcpServers.filter((s) => s.organizationId === null);
  const installedMcpNames = new Set(ownedMcpServers.map((s) => s.name));

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
        <Box className="grid w-full min-w-0 grid-cols-1 gap-5 sm:gap-6 lg:gap-8 lg:[grid-template-columns:repeat(2,minmax(0,1fr))] [&>*]:min-w-0">
          {/* Agents — z-10 so ModelSelector menus paint above the Groups card below (same grid column on lg) */}
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
              {/* Agent type selector */}
              <div>
                <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  Agent Type
                </label>
                <div className="grid grid-cols-2 gap-1 rounded-lg border border-gray-200 bg-gray-50/80 p-0.5 sm:grid-cols-4">
                  <button
                    type="button"
                    onClick={() => setNewAgentType("primary")}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-all duration-150 ${
                      newAgentType === "primary"
                        ? "bg-white text-indigo-700 shadow-sm ring-1 ring-indigo-200"
                        : "text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    <Bot className="h-3 w-3" />
                    Primary
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewAgentType("system")}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-all duration-150 ${
                      newAgentType === "system"
                        ? "bg-white text-emerald-700 shadow-sm ring-1 ring-emerald-200"
                        : "text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    <Cpu className="h-3 w-3" />
                    System
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewAgentType("external")}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-all duration-150 ${
                      newAgentType === "external"
                        ? "bg-white text-amber-700 shadow-sm ring-1 ring-amber-200"
                        : "text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    <Globe className="h-3 w-3" />
                    External
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewAgentType("application")}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-all duration-150 ${
                      newAgentType === "application"
                        ? "bg-white text-sky-700 shadow-sm ring-1 ring-sky-200"
                        : "text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    <Webhook className="h-3 w-3" />
                    Application
                  </button>
                </div>
                {newAgentType === "application" && (
                  <p className="mt-1.5 text-[10px] leading-relaxed text-gray-500">
                    REST-triggered deep agent. Invoked by an upstream client app via{" "}
                    <code className="rounded bg-gray-100 px-1 py-0.5 text-[9px]">
                      POST /api/application/&lt;id&gt;/invoke
                    </code>{" "}
                    — not via chat. The agent's <strong>instructions</strong> below become its
                    dedicated system prompt; the <strong>description</strong> is shown to primary
                    agents that have <code className="rounded bg-gray-100 px-1 py-0.5 text-[9px]">invoke_application_agent</code> granted.
                  </p>
                )}
              </div>
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
              <div>
                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  Description 
                </label>
                <input
                  type="text"
                  value={newAgentDescription}
                  onChange={(e) => setNewAgentDescription(e.target.value)}
                  placeholder="Short description of what this agent does"
                  className={inputClass}
                />
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
              {/* CLI MCP Access */}
              {mcpServers.length > 0 && (
              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  <Plug className="h-3 w-3" />
                  CLI MCP Access
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
                        <Plug className="h-3 w-3" />
                        {s.name}
                        {selected && <X className="h-3 w-3" />}
                      </button>
                    );
                  })}
                </div>
              </div>
              )}
              {/* Skills */}
              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  <Sparkles className="h-3 w-3" />
                  Skills
                </label>
                <div className="flex flex-wrap gap-1.5 rounded-xl border border-gray-200 bg-gray-50/80 p-2.5 min-h-[42px]">
                  {skills.filter((sk) => !sk.locked).map((sk) => {
                    const selected = newAgentSkillIds.includes(sk.id);
                    return (
                      <button
                        key={sk.id}
                        type="button"
                        onClick={() =>
                          setNewAgentSkillIds((prev) =>
                            selected ? prev.filter((id) => id !== sk.id) : [...prev, sk.id],
                          )
                        }
                        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-150 ${
                          selected
                            ? "bg-amber-100 text-amber-800 ring-1 ring-amber-200 shadow-sm"
                            : "bg-white text-gray-500 ring-1 ring-gray-200 hover:bg-gray-100 hover:text-gray-700"
                        }`}
                      >
                        <Sparkles className="h-3 w-3" />
                        {sk.name}
                        {selected && <X className="h-3 w-3" />}
                      </button>
                    );
                  })}
                  {skills.filter((sk) => !sk.locked).length === 0 && (
                    <p className="text-xs text-gray-400 py-1">No skills defined yet.</p>
                  )}
                </div>
              </div>
              {/* Tools */}
              {tools.length > 0 && (
              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  <Plug className="h-3 w-3" />
                  Tools
                  <span className="font-normal normal-case text-gray-400">(only basic tools if none selected — select explicitly for delegation/query access)</span>
                </label>
                <div className="flex flex-wrap gap-1.5 rounded-xl border border-gray-200 bg-gray-50/80 p-2.5 min-h-[42px]">
                  {tools.map((t) => {
                    const selected = newAgentToolIds.includes(t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() =>
                          setNewAgentToolIds((prev) =>
                            selected ? prev.filter((id) => id !== t.id) : [...prev, t.id],
                          )
                        }
                        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-150 ${
                          selected
                            ? "bg-violet-100 text-violet-800 ring-1 ring-violet-200 shadow-sm"
                            : "bg-white text-gray-500 ring-1 ring-gray-200 hover:bg-gray-100 hover:text-gray-700"
                        }`}
                      >
                        <Plug className="h-3 w-3" />
                        {t.name}
                        {selected && <X className="h-3 w-3" />}
                      </button>
                    );
                  })}
                </div>
              </div>
              )}
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

            {/* Primary Agents */}
            <div className="mb-4">
              <h3 className="mb-2.5 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-500">
                <Bot className="h-3.5 w-3.5 text-indigo-500" />
                Primary Agents
                <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-500">
                  {agents.filter((a) => a.type === "primary").length}
                </span>
              </h3>
              <div className="space-y-2.5">
                {agents.filter((a) => a.type === "primary").map((a) => (
                  <AgentCard key={a.id} agent={a} currentUserId={user!.id} currentUserRole={user!.role} allModels={models} allSkills={skills} allTools={tools} allMcpServers={mcpServers} onSaved={reload} />
                ))}
                {agents.filter((a) => a.type === "primary").length === 0 && (
                  <p className="py-2 text-xs text-gray-400">No primary agents yet.</p>
                )}
              </div>
            </div>

            {/* System Agents */}
            <div className="mb-4">
              <h3 className="mb-2.5 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-500">
                <Cpu className="h-3.5 w-3.5 text-emerald-500" />
                System Agents
                <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-500">
                  {agents.filter((a) => a.type === "system").length}
                </span>
              </h3>
              <div className="space-y-2.5">
                {agents.filter((a) => a.type === "system").map((a) => (
                  <AgentCard key={a.id} agent={a} currentUserId={user!.id} currentUserRole={user!.role} allModels={models} allSkills={skills} allTools={tools} allMcpServers={mcpServers} onSaved={reload} />
                ))}
                {agents.filter((a) => a.type === "system").length === 0 && (
                  <p className="py-2 text-xs text-gray-400">No system agents yet.</p>
                )}
              </div>
            </div>

            {/* System Agent Ownership — bind a system specialist to a single
                primary agent so only that primary can discover and delegate
                to it. "Shared (org-wide)" leaves it visible to every primary
                in the org (the legacy default — keep this for cross-cutting
                agents like google_workspace_agent or the active web-search
                agent). Server enforces that the picked owner is a primary
                in this org. */}
            {agents.filter((a) => a.type === "system").length > 0 && (
              <div className="mb-4">
                <h3 className="mb-2.5 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-500">
                  <Cpu className="h-3.5 w-3.5 text-emerald-500" />
                  System Agent Ownership
                  <span className="ml-1 text-[9px] font-normal normal-case text-gray-400">
                    private specialists vs. shared org-wide agents
                  </span>
                </h3>
                <p className="mb-2 text-[11px] text-gray-500">
                  Assign each system agent to a single primary agent that owns it.
                  Only that primary can list and delegate to an owned specialist.
                  Choose <strong>Shared (org-wide)</strong> for cross-cutting agents
                  every primary should be able to use.
                </p>
                <div className="overflow-hidden rounded-xl border border-gray-200/80 bg-white">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-gray-50 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                      <tr>
                        <th className="px-3 py-2">System agent</th>
                        <th className="px-3 py-2">Description</th>
                        <th className="px-3 py-2 w-64">Owner</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {agents
                        .filter((a) => a.type === "system")
                        .map((sa) => {
                          const ownerValue = sa.owningPrimaryAgentId ?? "";
                          const label =
                            sa.agentName?.trim() ||
                            sa.definition?.trim() ||
                            sa.id;
                          // Web-search candidates (Gemini + Tavily) and the
                          // Google Workspace agent are shared by design.
                          // Server rejects ownership PATCH for them; we
                          // mirror that here so the dropdown is inert.
                          const isSharedByDesign =
                            sa.slug !== null && SHARED_SYSTEM_AGENT_SLUGS.has(sa.slug);
                          const selectDisabled = sa.isLocked || isSharedByDesign;
                          return (
                            <tr key={sa.id} className="hover:bg-gray-50/60">
                              <td className="px-3 py-2 align-top">
                                <div className="font-semibold text-gray-800">{label}</div>
                                <div className="text-[10px] text-gray-400">{sa.id}</div>
                              </td>
                              <td className="px-3 py-2 align-top text-gray-600">
                                {sa.description?.trim() || (
                                  <span className="text-gray-400 italic">no description</span>
                                )}
                              </td>
                              <td className="px-3 py-2 align-top">
                                <select
                                  value={ownerValue}
                                  disabled={selectDisabled}
                                  onChange={(e) =>
                                    handleAssignSystemAgentOwner(
                                      sa.id,
                                      e.target.value === "" ? null : e.target.value,
                                    )
                                  }
                                  className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs focus:border-indigo-400 focus:outline-none disabled:bg-gray-100 disabled:text-gray-400"
                                >
                                  <option value="">
                                    {isSharedByDesign ? "Shared (org-wide, fixed)" : "Shared (org-wide)"}
                                  </option>
                                  {agents
                                    .filter((p) => p.type === "primary")
                                    .map((p) => (
                                      <option key={p.id} value={p.id}>
                                        {p.agentName?.trim() ||
                                          p.definition?.trim() ||
                                          p.id}
                                      </option>
                                    ))}
                                </select>
                                {isSharedByDesign && (
                                  <p className="mt-1 text-[10px] text-gray-400">
                                    Shared by design — every primary in the org must be able to delegate to this agent.
                                  </p>
                                )}
                                {!isSharedByDesign && sa.isLocked && (
                                  <p className="mt-1 text-[10px] text-gray-400">
                                    Locked agent — ownership cannot be changed here.
                                  </p>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Google Permissions — super_admin only (server also enforces).
                Grants calendar/drive/gmail operations per-(agent, subject user, scope). */}
            {user?.role === "super_admin" && (
              <GooglePermissionsSection agents={agents} />
            )}

            {/* Dedicated Web Search Agent (pick Gemini or Tavily — only one active) */}
            <div className="mb-4">
              <h3 className="mb-2.5 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-500">
                <Search className="h-3.5 w-3.5 text-sky-500" />
                Dedicated Web Search Agent
                <span className="rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-500">
                  {webSearchStatus?.activeChoice === "tavily" ? "Tavily" : "Gemini"}
                </span>
                <span className="ml-1 text-[9px] font-normal normal-case text-gray-400">
                  only one can be active
                </span>
              </h3>
              {webSearchStatus ? (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {(["gemini", "tavily"] as WebSearchChoice[]).map((choice) => {
                    const candidate =
                      choice === "tavily"
                        ? webSearchStatus.candidates.tavily
                        : webSearchStatus.candidates.gemini;
                    const isActive = webSearchStatus.activeChoice === choice;
                    const accent =
                      choice === "tavily"
                        ? "from-emerald-500 to-teal-600"
                        : "from-sky-500 to-indigo-600";
                    const icon = choice === "tavily" ? Search : Globe;
                    const Icon = icon;
                    return (
                      <button
                        key={choice}
                        type="button"
                        disabled={!candidate || webSearchSwitching}
                        onClick={() => handleSwitchWebSearchAgent(choice)}
                        className={`group relative flex items-start gap-3 rounded-xl border p-3 text-left transition-all duration-200 ${
                          isActive
                            ? "border-sky-300 bg-sky-50/60 shadow-sm"
                            : "border-gray-200/80 bg-white hover:border-indigo-300 hover:bg-white"
                        } ${!candidate ? "cursor-not-allowed opacity-60" : ""}`}
                      >
                        <div
                          className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${accent} text-white shadow-sm`}
                        >
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-semibold text-gray-900">
                              {candidate?.agentName ??
                                (choice === "tavily"
                                  ? "Tavily Web Search"
                                  : "Gemini Web Search")}
                            </span>
                            {isActive && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600">
                                <CheckCircle2 className="h-3 w-3" />
                                Active
                              </span>
                            )}
                          </div>
                          <p className="mt-1 line-clamp-2 text-[11px] text-gray-500">
                            {candidate?.description ??
                              (choice === "tavily"
                                ? "Routes web searches through the Tavily search API."
                                : "Uses Gemini's built-in web grounding for search.")}
                          </p>
                          {candidate?.modelSlug && (
                            <p className="mt-1 text-[10px] font-medium text-gray-400">
                              {candidate.modelSlug}
                            </p>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="py-2 text-xs text-gray-400">
                  Loading web-search configuration...
                </p>
              )}
            </div>

            {/* External Agents (roundtable-only) */}
            <div>
              <h3 className="mb-2.5 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-500">
                <Globe className="h-3.5 w-3.5 text-amber-500" />
                External Agents
                <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-500">
                  {agents.filter((a) => a.type === "external").length}
                </span>
                <span className="ml-1 text-[9px] font-normal normal-case text-gray-400">roundtable only</span>
              </h3>
              <div className="space-y-2.5">
                {agents.filter((a) => a.type === "external").map((a) => (
                  <AgentCard key={a.id} agent={a} currentUserId={user!.id} currentUserRole={user!.role} allModels={models} allSkills={skills} allTools={tools} allMcpServers={mcpServers} onSaved={reload} />
                ))}
                {agents.filter((a) => a.type === "external").length === 0 && (
                  <p className="py-2 text-xs text-gray-400">No external agents yet.</p>
                )}
              </div>
            </div>

            {/* Application Agents (REST-triggered, deepagents) */}
            <div className="mt-4">
              <h3 className="mb-2.5 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-500">
                <Webhook className="h-3.5 w-3.5 text-sky-500" />
                Application Agents
                <span className="rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-500">
                  {agents.filter((a) => a.type === "application").length}
                </span>
                <span className="ml-1 text-[9px] font-normal normal-case text-gray-400">REST endpoint</span>
              </h3>
              <div className="space-y-2.5">
                {agents.filter((a) => a.type === "application").map((a) => (
                  <AgentCard key={a.id} agent={a} currentUserId={user!.id} currentUserRole={user!.role} allModels={models} allSkills={skills} allTools={tools} allMcpServers={mcpServers} onSaved={reload} />
                ))}
                {agents.filter((a) => a.type === "application").length === 0 && (
                  <p className="py-2 text-xs text-gray-400">No application agents yet.</p>
                )}
              </div>
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
              {user?.role === "super_admin" && (
                <button
                  type="button"
                  onClick={() => {
                    setAddUserOpen((v) => !v);
                    setNewUserError(null);
                  }}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
                >
                  {addUserOpen ? <X className="h-3.5 w-3.5" /> : <UserPlus className="h-3.5 w-3.5" />}
                  {addUserOpen ? "Cancel" : "Add user"}
                </button>
              )}
            </h2>

            {user?.role === "super_admin" && addUserOpen && (
              <div className="mb-4 rounded-xl border border-indigo-100 bg-indigo-50/40 p-3 space-y-2">
                <p className="text-[11px] text-gray-500">
                  Creates a local (password-auth) user in this organization.
                  Works on tenants bootstrapped via Google Workspace too — the
                  new user signs in with username + password at the login page.
                </p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <input
                    type="text"
                    placeholder="Username (letters, digits, underscores)"
                    value={newUserUserName}
                    onChange={(e) => setNewUserUserName(e.target.value)}
                    autoComplete="off"
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                  <input
                    type="text"
                    placeholder="Display name"
                    value={newUserDisplayName}
                    onChange={(e) => setNewUserDisplayName(e.target.value)}
                    autoComplete="off"
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                  <input
                    type="password"
                    placeholder="Password (min 8, mixed case + digit + symbol)"
                    value={newUserPassword}
                    onChange={(e) => setNewUserPassword(e.target.value)}
                    autoComplete="new-password"
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                  <select
                    value={newUserRoleId}
                    onChange={(e) => setNewUserRoleId(e.target.value)}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  >
                    <option value="">Default role (user)</option>
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>
                {newUserError && (
                  <p className="text-[11px] text-red-600">{newUserError}</p>
                )}
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleCreateUser}
                    disabled={creatingUser}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
                  >
                    {creatingUser ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                    Create user
                  </button>
                </div>
              </div>
            )}

            <div className="max-h-[280px] overflow-y-auto space-y-2.5">
              {users.map((u) => (
                <UserCard key={u.id} u={u} roles={roles} currentUserRole={user?.role ?? "user"} onSaved={reload} />
              ))}
            </div>
          </div>

          {/* Organization summary — prepended to every agent's system prompt */}
          <div className="w-full min-w-0 rounded-2xl border border-gray-200/60 bg-white/80 p-4 sm:p-6 shadow-glass backdrop-blur-sm">
            <h2 className="mb-2 flex items-center gap-2.5 text-sm font-bold text-gray-900">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-sm">
                <Building2 className="h-4 w-4" />
              </div>
              Organization summary
              {organization?.name && (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                  {organization.name}
                </span>
              )}
            </h2>
            <p className="mb-3 text-xs text-gray-500">
              Injected into every agent's system prompt as shared grounding. Describe what your
              organization does, who the team is, and anything every agent should know.
            </p>
            <textarea
              value={orgSummaryDraft}
              onChange={(e) => setOrgSummaryDraft(e.target.value)}
              placeholder="A short description of what your organization does, who your team is, what you care about."
              rows={6}
              maxLength={4000}
              className="block w-full resize-y rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 transition focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-[11px] text-gray-400">
                {orgSummaryDraft.length} / 4000 characters
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOrgSummaryDraft(organization?.summary ?? "")}
                  disabled={
                    savingOrgSummary ||
                    orgSummaryDraft === (organization?.summary ?? "")
                  }
                  className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Reset
                </button>
                <button
                  type="button"
                  onClick={handleSaveOrgSummary}
                  disabled={
                    savingOrgSummary ||
                    orgSummaryDraft === (organization?.summary ?? "")
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:from-indigo-600 hover:to-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {savingOrgSummary ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Saving…
                    </>
                  ) : (
                    <>
                      <Save className="h-3.5 w-3.5" />
                      Save summary
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Shared library — admin-uploaded reference docs every agent can read */}
          <div className="w-full min-w-0 rounded-2xl border border-gray-200/60 bg-white/80 p-4 sm:p-6 shadow-glass backdrop-blur-sm">
            <h2 className="mb-2 flex items-center gap-2.5 text-sm font-bold text-gray-900">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 to-fuchsia-600 text-white shadow-sm">
                <BookOpen className="h-4 w-4" />
              </div>
              Shared library
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                {libraryFiles.length}
              </span>
            </h2>
            <p className="mb-3 text-xs text-gray-500">
              Reference documents shared by every agent in this organisation. Agents with the
              <code>filesystem</code> MCP attached can read library files directly from
              <code>/app/data/library</code> via <code>list_directory</code> and
              <code>read_text_file</code>. Upload the docs you want every agent to consult
              — policies, product briefs, domain cheat-sheets, standards, etc. Max 25 MB per file.
            </p>

            <input
              ref={libraryFileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleUploadLibraryFile(file);
              }}
            />
            <div className="mb-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => libraryFileInputRef.current?.click()}
                disabled={uploadingLibraryFile}
                className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-purple-500 to-fuchsia-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:from-purple-600 hover:to-fuchsia-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {uploadingLibraryFile ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Uploading…
                  </>
                ) : (
                  <>
                    <Upload className="h-3.5 w-3.5" />
                    Upload document
                  </>
                )}
              </button>
            </div>

            {libraryFiles.length === 0 ? (
              <p className="py-2 text-xs text-gray-400">
                No documents uploaded yet. Add one so your agents can reference it in every conversation.
              </p>
            ) : (
              <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
                {libraryFiles.map((f) => {
                  const kb = Math.max(1, Math.round(f.size / 1024));
                  const updated = new Date(f.updatedAt).toLocaleString();
                  const isDeleting = deletingLibraryFile === f.fileName;
                  const isDownloading = downloadingLibraryFile === f.fileName;
                  return (
                    <li
                      key={f.fileName}
                      className="flex items-center gap-3 px-3 py-2.5"
                    >
                      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-purple-50 text-purple-600">
                        <FileText className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-gray-900">
                          {f.fileName}
                        </div>
                        <div className="text-[11px] text-gray-400">
                          {kb} KB · updated {updated}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDownloadLibraryFile(f.fileName)}
                        disabled={isDownloading || isDeleting}
                        className="inline-flex items-center gap-1 rounded-lg border border-purple-200 bg-white px-2.5 py-1 text-xs font-semibold text-purple-600 transition hover:bg-purple-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isDownloading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                        Download
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteLibraryFile(f.fileName)}
                        disabled={isDeleting || isDownloading}
                        className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs font-semibold text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isDeleting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                        Delete
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
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
                      {agents.filter((a) => a.type === "primary").map((a) => {
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

          {/* Vendor API Keys — per-org. Super-admin only: these credentials
              belong to THIS organization and are used by all agents in it.
              The Claude Code OAuth token sits in the same card because it is
              also a credential the platform uses to authenticate models, just
              system-wide rather than per-org. */}
          {user?.role === "super_admin" && (
            <VendorApiKeysCard
              vendorApiKeys={vendorApiKeys}
              claudeOauthToken={claudeOauthToken}
              codexApiKey={codexApiKey}
              codexAuthJson={codexAuthJson}
              reload={reload}
              setError={setError}
            />
          )}

          {/* Claude/Codex CLI MCP registry */}
          {user?.role === "super_admin" && (
            <div className="w-full min-w-0 lg:col-span-2 rounded-2xl border border-gray-200/60 bg-white/80 p-4 sm:p-6 shadow-glass backdrop-blur-sm">
              <h2 className="mb-5 flex flex-wrap items-center gap-2.5 text-sm font-bold text-gray-900">
                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-sm">
                  <Plug className="h-4 w-4" />
                </div>
                CLI MCP Servers
                <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-violet-600 ring-1 ring-violet-100">
                  Claude / Codex
                </span>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                  {ownedMcpServers.length} private / {publicMcpServers.length} public
                </span>
              </h2>

              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
                <div className="min-w-0 space-y-4">
                  <div>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">
                        Private CLI Servers
                      </h3>
                      {editingMcpId && (
                        <button
                          type="button"
                          onClick={resetMcpForm}
                          className="text-xs font-semibold text-gray-500 hover:text-gray-900"
                        >
                          Cancel edit
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                      {ownedMcpServers.map((s) => (
                        <div
                          key={s.id}
                          className="min-w-0 rounded-xl border border-gray-200/60 bg-white p-3.5 shadow-glass"
                        >
                          <div className="flex min-w-0 items-start gap-3">
                            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-100 to-purple-100 text-violet-600">
                              {s.isScript ? <FileText className="h-4 w-4" /> : <Terminal className="h-4 w-4" />}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-semibold text-gray-900">{s.name}</p>
                                  {s.description && (
                                    <p className="mt-0.5 line-clamp-2 text-[11px] text-gray-500">{s.description}</p>
                                  )}
                                </div>
                                <div className="flex flex-shrink-0 items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => startEditMcp(s)}
                                    className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                                    title="Edit CLI MCP server"
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteMcpServer(s)}
                                    disabled={mcpDeletingId === s.id}
                                    className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                                    title="Delete CLI MCP server"
                                  >
                                    {mcpDeletingId === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                                  </button>
                                </div>
                              </div>
                              <p className="mt-2 break-all font-mono text-[10px] text-gray-400">
                                {s.isScript ? "custom JS script" : `${s.command} ${s.args.join(" ")}`}
                              </p>
                              <span className="mt-2 inline-block rounded-full bg-violet-50 px-2 py-0.5 text-[9px] font-semibold uppercase text-violet-500">
                                {s.isScript ? "script" : s.transport}
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                      {ownedMcpServers.length === 0 && (
                        <p className="rounded-xl border border-dashed border-gray-200 bg-gray-50/70 p-5 text-center text-xs text-gray-400 sm:col-span-2">
                          No private CLI MCP servers yet.
                        </p>
                      )}
                    </div>
                  </div>

                  <div>
                    <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-gray-500">
                      Shared CLI Templates
                    </h3>
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                      {publicMcpServers.map((s) => {
                        const installed = installedMcpNames.has(s.name);
                        return (
                          <div
                            key={s.id}
                            className="min-w-0 rounded-xl border border-gray-200/60 bg-white p-3.5 shadow-glass"
                          >
                            <div className="flex min-w-0 items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-gray-900">{s.name}</p>
                                {s.description && (
                                  <p className="mt-0.5 line-clamp-2 text-[11px] text-gray-500">{s.description}</p>
                                )}
                                <p className="mt-1 break-all font-mono text-[10px] text-gray-400">
                                  {s.command} {s.args.join(" ")}
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleInstallMcpServer(s)}
                                disabled={installed || mcpInstallingId === s.id}
                                className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-violet-50 px-2.5 py-1.5 text-[11px] font-semibold text-violet-700 ring-1 ring-violet-100 transition-all hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {mcpInstallingId === s.id ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : installed ? (
                                  <CheckCircle2 className="h-3 w-3" />
                                ) : (
                                  <Download className="h-3 w-3" />
                                )}
                                {installed ? "Installed" : "Install"}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                      {publicMcpServers.length === 0 && (
                        <p className="rounded-xl border border-dashed border-gray-200 bg-gray-50/70 p-5 text-center text-xs text-gray-400 sm:col-span-2">
                          No shared CLI MCP templates are available.
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="min-w-0 rounded-xl border border-gray-200/70 bg-white p-4 shadow-glass">
                  <h3 className="mb-3 text-sm font-bold text-gray-900">
                    {editingMcpId ? "Edit CLI MCP Server" : "Add CLI MCP Server"}
                  </h3>
                  <div className="mb-3 grid grid-cols-2 rounded-xl bg-gray-100 p-1">
                    <button
                      type="button"
                      onClick={() => setMcpForm((p) => ({ ...p, mode: "command" }))}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${mcpForm.mode === "command" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800"}`}
                    >
                      Command
                    </button>
                    <button
                      type="button"
                      onClick={() => setMcpForm((p) => ({ ...p, mode: "script" }))}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${mcpForm.mode === "script" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800"}`}
                    >
                      Custom JS
                    </button>
                  </div>

                  <div className="space-y-3">
                    <input
                      value={mcpForm.name}
                      onChange={(e) => setMcpForm((p) => ({ ...p, name: e.target.value }))}
                      placeholder="Name"
                      className={inputClass}
                    />
                    <input
                      value={mcpForm.description}
                      onChange={(e) => setMcpForm((p) => ({ ...p, description: e.target.value }))}
                      placeholder="Description"
                      className={inputClass}
                    />

                    {mcpForm.mode === "command" ? (
                      <>
                        <input
                          value={mcpForm.command}
                          onChange={(e) => setMcpForm((p) => ({ ...p, command: e.target.value }))}
                          placeholder="Command, e.g. npx"
                          className={inputClass + " font-mono"}
                        />
                        <textarea
                          value={mcpForm.argsText}
                          onChange={(e) => setMcpForm((p) => ({ ...p, argsText: e.target.value }))}
                          placeholder={"Arguments, one per line\n-y\n@modelcontextprotocol/server-filesystem\n/app/data"}
                          rows={4}
                          className={inputClass + " font-mono text-xs"}
                        />
                      </>
                    ) : (
                      <textarea
                        value={mcpForm.scriptContent}
                        onChange={(e) => setMcpForm((p) => ({ ...p, scriptContent: e.target.value }))}
                        placeholder="Paste the Node.js MCP server script used by the CLI"
                        rows={10}
                        className={inputClass + " font-mono text-xs"}
                      />
                    )}

                    <textarea
                      value={mcpForm.envText}
                      onChange={(e) => setMcpForm((p) => ({ ...p, envText: e.target.value }))}
                      placeholder='Env JSON, e.g. {"GITHUB_TOKEN":"{{GITHUB_TOKEN}}"}'
                      rows={3}
                      className={inputClass + " font-mono text-xs"}
                    />

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={handleSaveMcpServer}
                        disabled={mcpSaving}
                        className={btnPrimary}
                      >
                        {mcpSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        {editingMcpId ? "Save" : "Create"}
                      </button>
                      {editingMcpId && (
                        <button
                          type="button"
                          onClick={resetMcpForm}
                          className="inline-flex items-center gap-2 rounded-xl bg-gray-100 px-4 py-2.5 text-sm font-semibold text-gray-700 transition-all hover:bg-gray-200"
                        >
                          <X className="h-4 w-4" />
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Skills library — platform-wide catalog, read-only in the UI. */}
          {user?.role === "super_admin" && (
          <div className="w-full min-w-0 lg:col-span-2 rounded-2xl border border-gray-200/60 bg-white/80 p-4 sm:p-6 shadow-glass backdrop-blur-sm">
            <h2 className="mb-5 flex items-center gap-2.5 text-sm font-bold text-gray-900">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-sm">
                <Sparkles className="h-4 w-4" />
              </div>
              Skills
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                {skills.length}
              </span>
              <span className="ml-1 text-[10px] font-normal text-gray-400">(platform catalog — managed out-of-band)</span>
            </h2>

            <div className="grid w-full min-w-0 grid-cols-1 gap-2.5 sm:[grid-template-columns:repeat(2,minmax(0,1fr))] lg:[grid-template-columns:repeat(3,minmax(0,1fr))]">
              {skills.map((sk) => (
                <div
                  key={sk.id}
                  className="min-w-0 rounded-xl border border-gray-200/60 bg-white p-3.5 shadow-glass"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{sk.name}</p>
                    {sk.slug && (
                      <p className="font-mono text-[10px] text-gray-400 truncate">{sk.slug}</p>
                    )}
                  </div>
                  {sk.description && (
                    <p className="mt-1.5 text-[11px] text-gray-500 line-clamp-2">{sk.description}</p>
                  )}
                  {sk.locked && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] font-medium text-gray-500 ring-1 ring-gray-200">Locked</span>
                    </div>
                  )}
                  <p className="mt-2 max-h-20 overflow-hidden text-[10px] leading-snug text-gray-400 font-mono line-clamp-4">
                    {sk.skillText}
                  </p>
                </div>
              ))}
              {skills.length === 0 && (
                <p className="col-span-full py-6 text-center text-xs text-gray-400">
                  No skills configured.
                </p>
              )}
            </div>
          </div>
          )}


          {/* Models */}
          <div className="w-full min-w-0 lg:col-span-2 rounded-2xl border border-gray-200/60 bg-white/80 p-4 sm:p-6 shadow-glass backdrop-blur-sm">
            <h2 className="mb-1 flex items-center gap-2.5 text-sm font-bold text-gray-900">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-pink-500 to-rose-600 text-white shadow-sm">
                <Cpu className="h-4 w-4" />
              </div>
              Models
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                {models.length}
              </span>
            </h2>
            <p className="mb-5 text-[11px] text-gray-400">
              (platform catalog — managed out-of-band)
            </p>

            <div className="grid w-full min-w-0 grid-cols-1 gap-2.5 sm:[grid-template-columns:repeat(2,minmax(0,1fr))] lg:[grid-template-columns:repeat(3,minmax(0,1fr))] [&>*]:min-w-0">
              {models.map((m) => (
                <div
                  key={m.id}
                  className="flex min-w-0 items-center gap-2.5 sm:gap-3 rounded-xl border border-gray-200/60 bg-white p-3 sm:p-3.5 shadow-glass"
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
                </div>
              ))}
              {models.length === 0 && (
                <p className="col-span-full py-6 text-center text-xs text-gray-400">
                  No models configured.
                </p>
              )}
            </div>
          </div>

          {/* ── Epic Orchestrator — super_admin only ── */}
          {user?.role === "super_admin" && (
          <div className="w-full min-w-0 lg:col-span-2 rounded-2xl border border-gray-200/60 bg-white/80 p-4 sm:p-6 shadow-glass backdrop-blur-sm">
            <h2 className="mb-5 flex items-center gap-2.5 text-sm font-bold text-gray-900">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-sm">
                <FolderGit2 className="h-4 w-4" />
              </div>
              Epic Orchestrator
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                {projects.length} project{projects.length !== 1 ? "s" : ""}
              </span>
            </h2>

            {/* ── List view ── */}
            {epicView === "list" && (
              <>
                <button
                  onClick={() => { resetWizard(); setEpicView("wizard"); }}
                  className={btnPrimary + " mb-5"}
                >
                  <Plus className="h-4 w-4" /> New Project
                </button>

                {projects.length === 0 && (
                  <p className="text-sm text-gray-400 italic">No projects yet. Create one to get started.</p>
                )}

                <div className="space-y-3">
                  {projects.map((p) => (
                    <div key={p.id} className="rounded-xl border border-gray-200/60 bg-gray-50/50">
                      {/* Project header */}
                      <div
                        className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
                        onClick={() => setExpandedProjectId(expandedProjectId === p.id ? null : p.id)}
                      >
                        {expandedProjectId === p.id ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-gray-900">{p.name}</p>
                          {p.description && <p className="text-xs text-gray-500 truncate">{p.description}</p>}
                        </div>
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">
                          {p.repositories.length} repo{p.repositories.length !== 1 ? "s" : ""}
                        </span>
                        <button
                          onClick={(e) => { e.stopPropagation(); startEditProject(p); }}
                          className="rounded-xl p-1.5 text-gray-400 transition hover:bg-blue-50 hover:text-blue-500"
                          title="Edit project"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteProject(p.id); }}
                          className="rounded-xl p-1.5 text-gray-300 transition hover:bg-red-50 hover:text-red-500"
                          title="Delete project"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      {/* Expanded project details */}
                      {expandedProjectId === p.id && (
                        <div className="border-t border-gray-200/60 px-4 py-3 space-y-3">
                          {/* Edit project form */}
                          {editingProjectId === p.id ? (
                            <div className="space-y-2 rounded-xl border border-dashed border-blue-200 bg-blue-50/30 p-3">
                              <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-400">Edit project</p>
                              <input value={editProjName} onChange={(e) => setEditProjName(e.target.value)} placeholder="Name" className={inputClass} />
                              <input value={editProjDescription} onChange={(e) => setEditProjDescription(e.target.value)} placeholder="Description" className={inputClass} />
                              <textarea value={editProjArchitecture} onChange={(e) => setEditProjArchitecture(e.target.value)} placeholder="Architecture overview" rows={3} className={inputClass + " resize-y font-mono text-xs"} />
                              <input value={editProjTechStack} onChange={(e) => setEditProjTechStack(e.target.value)} placeholder="Tech stack (e.g. React 18, Node 20, PostgreSQL 15)" className={inputClass} />
                              <div className="flex gap-2">
                                <button onClick={() => handleSaveProject(p.id)} disabled={savingProjectId === p.id} className={btnPrimary}>
                                  {savingProjectId === p.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
                                </button>
                                <button onClick={() => setEditingProjectId(null)} className="rounded-xl px-3 py-2 text-sm text-gray-500 transition hover:bg-gray-100">
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-1 text-xs text-gray-500">
                              {p.techStack && <p><strong>Tech:</strong> {p.techStack}</p>}
                              {p.architectureOverview && <p className="whitespace-pre-wrap font-mono text-[11px]">{p.architectureOverview}</p>}
                            </div>
                          )}

                          {/* Repositories list */}
                          {p.repositories.length === 0 && (
                            <p className="text-xs text-gray-400 italic">No repositories yet.</p>
                          )}
                          {p.repositories.map((r) => (
                            <div key={r.id} className="rounded-lg border border-gray-200/80 bg-white p-3 space-y-2">
                              {editingRepoId === r.id ? (
                                <div className="space-y-2">
                                  <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-400">Edit repository</p>
                                  <input value={editRepoName} onChange={(e) => setEditRepoName(e.target.value)} placeholder="Name" className={inputClass} />
                                  <textarea value={editRepoArchitecture} onChange={(e) => setEditRepoArchitecture(e.target.value)} placeholder="Architecture overview" rows={2} className={inputClass + " resize-y font-mono text-xs"} />
                                  <textarea value={editRepoSetupInstructions} onChange={(e) => setEditRepoSetupInstructions(e.target.value)} placeholder="Setup instructions" rows={2} className={inputClass + " resize-y font-mono text-xs"} />
                                  <input value={editRepoAgentName} onChange={(e) => setEditRepoAgentName(e.target.value)} placeholder="CLI agent name (e.g. Dag)" className={inputClass} />
                                  <div className="flex gap-2">
                                    <button onClick={() => handleSaveRepo(r.id)} disabled={savingRepoId === r.id} className={btnPrimary}>
                                      {savingRepoId === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
                                    </button>
                                    <button onClick={() => setEditingRepoId(null)} className="rounded-xl px-3 py-2 text-sm text-gray-500 transition hover:bg-gray-100">
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <div className="flex items-center gap-2">
                                    <Globe className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                                    <span className="text-sm font-semibold text-gray-900">{r.name}</span>
                                    <span className="font-mono text-[10px] text-gray-400 truncate">{r.url}</span>
                                    <div className="ml-auto flex items-center gap-1">
                                      <button onClick={() => startEditRepo(r)} className="rounded-lg p-1 text-gray-400 transition hover:bg-blue-50 hover:text-blue-500" title="Edit"><Pencil className="h-3 w-3" /></button>
                                      <button onClick={() => handleDeleteRepo(r.id)} className="rounded-lg p-1 text-gray-300 transition hover:bg-red-50 hover:text-red-500" title="Delete"><Trash2 className="h-3 w-3" /></button>
                                    </div>
                                  </div>
                                  <div className="flex flex-wrap items-center gap-2 text-xs">
                                    <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-indigo-700">
                                      <GitBranch className="h-3 w-3" /> {r.defaultBranch}
                                    </span>
                                    {r.agentName && (
                                      <span className="inline-flex items-center gap-1 rounded-full bg-purple-50 px-2 py-0.5 text-purple-700">
                                        Agent: {r.agentName}
                                      </span>
                                    )}
                                    {r.localPath ? (
                                      <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-green-700">
                                        <CheckCircle2 className="h-3 w-3" /> Cloned
                                      </span>
                                    ) : (
                                      <button onClick={() => handleCloneRepo(r.id)} disabled={cloningRepoId === r.id} className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-amber-700 transition hover:bg-amber-100 disabled:opacity-50">
                                        {cloningRepoId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                                        {cloningRepoId === r.id ? "Cloning..." : "Clone"}
                                      </button>
                                    )}
                                    {r.localPath && (
                                      <>
                                        {branchesRepoId === r.id ? (
                                          <div className="flex min-w-[220px] items-center gap-1.5">
                                            {loadingBranches ? <Loader2 className="h-3 w-3 animate-spin text-gray-400" /> : (
                                              <div className="flex-1">
                                                <BranchPicker
                                                  branches={availableBranches}
                                                  value=""
                                                  currentBranch={r.defaultBranch}
                                                  placeholder="Switch to branch..."
                                                  disabled={settingBranch}
                                                  onChange={(b) => { if (b) handleSetBranch(r.id, b); }}
                                                />
                                              </div>
                                            )}
                                            <button onClick={() => setBranchesRepoId(null)} className="rounded-md p-0.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"><X className="h-3 w-3" /></button>
                                          </div>
                                        ) : (
                                          <button onClick={() => handleLoadBranches(r.id)} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-gray-600 transition hover:bg-gray-200">
                                            <GitBranch className="h-3 w-3" /> Switch branch
                                          </button>
                                        )}
                                      </>
                                    )}
                                    {r.localPath && (
                                      <button onClick={() => handleGenerateArchitecture(r.id)} disabled={generatingArchRepoId === r.id} className="inline-flex items-center gap-1 rounded-full bg-purple-50 px-2.5 py-0.5 text-purple-700 transition hover:bg-purple-100 disabled:opacity-50">
                                        {generatingArchRepoId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                                        {generatingArchRepoId === r.id ? "Generating..." : r.architectureOverview ? "Regenerate architecture" : "Generate architecture"}
                                      </button>
                                    )}
                                  </div>
                                  {r.localPath && <p className="font-mono text-[10px] text-gray-400">{r.localPath}</p>}
                                  {r.architectureOverview && <p className="whitespace-pre-wrap font-mono text-[11px] text-gray-500">{r.architectureOverview}</p>}
                                  {r.setupInstructions && <p className="whitespace-pre-wrap text-[11px] text-gray-500"><strong>Setup:</strong> {r.setupInstructions}</p>}
                                </>
                              )}
                            </div>
                          ))}

                          {/* Add Repository form */}
                          {addRepoProjectId === p.id ? (
                            <div className="rounded-lg border border-dashed border-emerald-300 bg-emerald-50/30 p-3 space-y-2">
                              <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-500">Add repository</p>
                              <div className="flex gap-2">
                                <input value={addRepoName} onChange={(e) => setAddRepoName(e.target.value)} placeholder="Repository name (e.g. my-repo)" className={inputClass + " flex-1"} />
                                <button onClick={handleAddRepoFetchBranches} disabled={!addRepoName.trim() || addRepoLoadingBranches} className="inline-flex items-center gap-1 rounded-xl bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-200 disabled:opacity-50">
                                  {addRepoLoadingBranches ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitBranch className="h-3.5 w-3.5" />} Fetch branches
                                </button>
                              </div>
                              {addRepoBranches.length > 0 && (
                                <>
                                  <div>
                                    <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-emerald-500/80">
                                      Branch * <span className="ml-1 font-normal normal-case tracking-normal text-gray-400">({addRepoBranches.length} available)</span>
                                    </label>
                                    <BranchPicker
                                      branches={addRepoBranches}
                                      value={addRepoBranch}
                                      onChange={setAddRepoBranch}
                                    />
                                  </div>
                                  <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none">
                                    <input type="checkbox" checked={addRepoGenArch} onChange={(e) => setAddRepoGenArch(e.target.checked)} className="rounded border-gray-300" />
                                    <Sparkles className="h-3 w-3 text-purple-500" /> Generate architecture overview with Claude
                                  </label>
                                  {!addRepoGenArch && (
                                    <textarea value={addRepoArchitecture} onChange={(e) => setAddRepoArchitecture(e.target.value)} placeholder="Architecture overview (optional)" rows={2} className={inputClass + " resize-y font-mono text-xs"} />
                                  )}
                                  <textarea value={addRepoSetupInstructions} onChange={(e) => setAddRepoSetupInstructions(e.target.value)} placeholder="Setup instructions (optional)" rows={2} className={inputClass + " resize-y font-mono text-xs"} />
                                  <div className="flex gap-2">
                                    <button onClick={handleAddRepoSubmit} disabled={!addRepoBranch || addingRepo} className={btnPrimary}>
                                      {addingRepo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add Repository
                                    </button>
                                    <button onClick={resetAddRepoForm} className="rounded-xl px-3 py-2 text-sm text-gray-500 transition hover:bg-gray-100">Cancel</button>
                                  </div>
                                </>
                              )}
                            </div>
                          ) : (
                            <button onClick={() => setAddRepoProjectId(p.id)} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs font-medium text-gray-500 transition hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-600">
                              <Plus className="h-3.5 w-3.5" /> Add Repository
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* ── Create project wizard ── */}
            {epicView === "wizard" && (
              <div className="space-y-4">
                {/* Step indicators */}
                <div className="flex items-center gap-3 mb-2">
                  <button onClick={() => setWizardStep(1)} className={`rounded-full px-3 py-1 text-xs font-semibold transition ${wizardStep === 1 ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}>
                    1. Project Details
                  </button>
                  <div className="h-px w-4 bg-gray-300" />
                  <button onClick={() => { if (newProjName.trim()) setWizardStep(2); }} disabled={!newProjName.trim()} className={`rounded-full px-3 py-1 text-xs font-semibold transition ${wizardStep === 2 ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"} disabled:opacity-40`}>
                    2. Repositories
                  </button>
                  <button onClick={() => { resetWizard(); setEpicView("list"); }} className="ml-auto rounded-xl px-3 py-2 text-sm text-gray-500 transition hover:bg-gray-100">Cancel</button>
                </div>

                {/* Step 1: Project details */}
                {wizardStep === 1 && (
                  <div className="space-y-3 rounded-xl border border-dashed border-gray-200 bg-gray-50/50 p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Project details</p>
                    <input value={newProjName} onChange={(e) => setNewProjName(e.target.value)} placeholder="Project name *" className={inputClass} />
                    <input value={newProjDescription} onChange={(e) => setNewProjDescription(e.target.value)} placeholder="Description" className={inputClass} />
                    <textarea value={newProjArchitecture} onChange={(e) => setNewProjArchitecture(e.target.value)} placeholder="Architecture overview (folder tree, component structure, boundaries...)" rows={4} className={inputClass + " resize-y font-mono text-xs"} />
                    <input value={newProjTechStack} onChange={(e) => setNewProjTechStack(e.target.value)} placeholder="Tech stack (e.g. React 18, Node 20, PostgreSQL 15, Redis)" className={inputClass} />
                    <button onClick={() => setWizardStep(2)} disabled={!newProjName.trim()} className={btnPrimary}>
                      Next: Add Repositories
                    </button>
                  </div>
                )}

                {/* Step 2: Repositories */}
                {wizardStep === 2 && (
                  <div className="space-y-4">
                    {/* Repos already added (client-side list) */}
                    {wizardRepos.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Repositories to create ({wizardRepos.length})</p>
                        {wizardRepos.map((r, idx) => (
                          <div key={idx} className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200/80 bg-white px-3 py-2 text-xs">
                            <Globe className="h-3.5 w-3.5 text-gray-400" />
                            <span className="font-semibold text-gray-900">{r.name}</span>
                            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-indigo-700">
                              <GitBranch className="h-3 w-3" /> {r.branch}
                            </span>
                            {r.generateArchitecture ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-purple-50 px-2 py-0.5 text-purple-700">
                                <Sparkles className="h-3 w-3" /> Auto-generate
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-green-700">
                                <CheckCircle2 className="h-3 w-3" /> Manual arch.
                              </span>
                            )}
                            <button onClick={() => handleWizEditRepo(idx)} className="ml-auto rounded-lg p-1 text-gray-300 transition hover:bg-indigo-50 hover:text-indigo-500" title="Edit">
                              <Pencil className="h-3 w-3" />
                            </button>
                            <button onClick={() => handleWizRemoveRepo(idx)} className="rounded-lg p-1 text-gray-300 transition hover:bg-red-50 hover:text-red-500" title="Remove">
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Add repo form */}
                    <div className="space-y-3 rounded-xl border border-dashed border-gray-200 bg-gray-50/50 p-4">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Add repository</p>

                      {/* Repo name + fetch branches */}
                      <div className="flex gap-2">
                        <input value={wizRepoName} onChange={(e) => { setWizRepoName(e.target.value); setWizRepoBranches([]); setWizRepoBranch(""); }} placeholder="Repository name (e.g. sched-assist)" className={inputClass + " flex-1"} />
                        <button onClick={handleWizFetchBranches} disabled={!wizRepoName.trim() || wizRepoLoadingBranches} className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50">
                          {wizRepoLoadingBranches ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitBranch className="h-4 w-4" />}
                          Fetch branches
                        </button>
                      </div>

                      {/* Branch selector (visible after fetch) */}
                      {wizRepoBranches.length > 0 && (
                        <>
                          <div>
                            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                              Branch * <span className="ml-1 font-normal normal-case tracking-normal text-gray-400/80">({wizRepoBranches.length} available)</span>
                            </label>
                            <BranchPicker
                              branches={wizRepoBranches}
                              value={wizRepoBranch}
                              onChange={setWizRepoBranch}
                            />
                          </div>

                          {/* Architecture: generate or manual */}
                          <div>
                            <label className="mb-2 flex items-center gap-2 text-xs font-medium text-gray-700">
                              <input type="checkbox" checked={wizRepoGenArch} onChange={(e) => { setWizRepoGenArch(e.target.checked); if (e.target.checked) setWizRepoArchitecture(""); }} className="rounded border-gray-300" />
                              <Sparkles className="h-3.5 w-3.5 text-purple-500" />
                              Let Claude generate the architecture overview
                            </label>
                            {!wizRepoGenArch && (
                              <textarea value={wizRepoArchitecture} onChange={(e) => setWizRepoArchitecture(e.target.value)} placeholder="Architecture overview * (folder tree, component structure...)" rows={3} className={inputClass + " resize-y font-mono text-xs"} />
                            )}
                          </div>

                          {/* Setup instructions */}
                          <textarea value={wizRepoSetupInstructions} onChange={(e) => setWizRepoSetupInstructions(e.target.value)} placeholder="Setup instructions (optional — install deps, env vars, dev server...)" rows={2} className={inputClass + " resize-y font-mono text-xs"} />

                          {/* Add to list button */}
                          <div className="flex gap-2">
                            <button
                              onClick={handleWizAddRepo}
                              disabled={!wizRepoName.trim() || !wizRepoBranch || (!wizRepoGenArch && !wizRepoArchitecture.trim())}
                              className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-40"
                            >
                              {wizEditingRepoIdx !== null ? <><CheckCircle2 className="h-4 w-4" /> Update</> : <><Plus className="h-4 w-4" /> Add to list</>}
                            </button>
                            {wizEditingRepoIdx !== null && (
                              <button
                                onClick={resetWizRepoForm}
                                className="rounded-xl px-3 py-2 text-sm text-gray-500 transition hover:bg-gray-100"
                              >
                                Cancel
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </div>

                    {/* Submit all */}
                    <div className="flex gap-2">
                      <button onClick={() => setWizardStep(1)} className="rounded-xl px-3 py-2 text-sm text-gray-500 transition hover:bg-gray-100">
                        Back
                      </button>
                      <button
                        onClick={handleSubmitWizard}
                        disabled={submittingProject || wizardRepos.length === 0}
                        className={btnPrimary}
                      >
                        {submittingProject ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                        {submittingProject ? "Setting up..." : `Create Project & ${wizardRepos.length} Repo${wizardRepos.length !== 1 ? "s" : ""}`}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          )}

        </Box>
      </Stack>
      </Container>
    </Stack>
  );
}

// ── Vendor API Keys (super_admin only, per-org) ──────────────────────────────

interface VendorApiKeyEntry {
  vendorId: string;
  vendorName: string;
  vendorSlug: string;
  hasApiKey: boolean;
  masked: string | null;
  updatedAt: string | null;
}

/**
 * Per-organization vendor API keys card. The endpoints are gated by
 * `requireSuperAdmin` and the server pulls the orgId from the JWT, so this
 * card never has the power to touch another org's credentials regardless of
 * what the client sends.
 */
function VendorApiKeysCard({
  vendorApiKeys,
  claudeOauthToken,
  codexApiKey,
  codexAuthJson,
  reload,
  setError,
}: {
  vendorApiKeys: VendorApiKeyEntry[];
  claudeOauthToken: {
    configured: boolean;
    masked: string | null;
    updatedAt: string | null;
  } | null;
  codexApiKey: {
    configured: boolean;
    masked: string | null;
    updatedAt: string | null;
  } | null;
  codexAuthJson: {
    configured: boolean;
    accountIdSuffix: string | null;
    accessTokenMasked: string | null;
    hasRefreshToken: boolean;
    hasOpenaiApiKey: boolean;
    lastRefresh: string | null;
    updatedAt: string | null;
  } | null;
  reload: () => Promise<void>;
  setError: (msg: string) => void;
}) {
  return (
    <div className="w-full min-w-0 lg:col-span-2 rounded-2xl border border-gray-200/60 bg-white/80 p-4 sm:p-6 shadow-glass backdrop-blur-sm">
      <h2 className="mb-2 flex items-center gap-2.5 text-sm font-bold text-gray-900">
        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-sm">
          <KeyRound className="h-4 w-4" />
        </div>
        Credentials
        <span className="ml-1 text-[10px] font-normal text-gray-400">
          (your organization&apos;s vendor and CLI credentials)
        </span>
      </h2>
      <p className="mb-5 text-xs text-gray-500">
        These keys are used by every agent in your organization when it calls
        the corresponding vendor. CLI credentials are stored server-side on the
        agent service; raw values are never sent back to the browser.
      </p>

      <div className="grid w-full min-w-0 grid-cols-1 gap-3 sm:[grid-template-columns:repeat(2,minmax(0,1fr))] lg:[grid-template-columns:repeat(3,minmax(0,1fr))] [&>*]:min-w-0">
        {vendorApiKeys.map((v) => (
          <VendorApiKeyRow
            key={v.vendorId}
            entry={v}
            reload={reload}
            setError={setError}
          />
        ))}
        <ClaudeOauthTokenRow
          entry={claudeOauthToken}
          reload={reload}
          setError={setError}
        />
        <CodexAuthJsonRow
          entry={codexAuthJson}
          reload={reload}
          setError={setError}
        />
        <CodexApiKeyRow
          entry={codexApiKey}
          reload={reload}
          setError={setError}
        />
      </div>
    </div>
  );
}

function VendorApiKeyRow({
  entry,
  reload,
  setError,
}: {
  entry: VendorApiKeyEntry;
  reload: () => Promise<void>;
  setError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed) {
      setError("API key cannot be empty. Use Remove to clear it.");
      return;
    }
    setBusy(true);
    try {
      await admin.setVendorApiKey(entry.vendorId, trimmed);
      setDraft("");
      setEditing(false);
      await reload();
    } catch (err: any) {
      setError(err?.message ?? "Failed to save key.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    // Single-step delete is fine here — the key can always be re-entered, and
    // the only consequence of an accidental click is that agents using this
    // vendor will surface a clear "your org has not configured an API key for
    // …" error on the next call, prompting a re-set.
    setBusy(true);
    try {
      await admin.deleteVendorApiKey(entry.vendorId);
      setDraft("");
      setEditing(false);
      await reload();
    } catch (err: any) {
      setError(err?.message ?? "Failed to remove key.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-w-0 rounded-xl border border-gray-200/60 bg-white p-4 shadow-glass transition-all duration-200">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-gray-200/80 bg-gray-50 text-gray-600">
          <VendorIcon slug={entry.vendorSlug} />
        </div>
        <span className="min-w-0 truncate text-sm font-semibold text-gray-900">
          {entry.vendorName}
        </span>
        {entry.hasApiKey ? (
          <span className="ml-auto rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">
            Configured
          </span>
        ) : (
          <span className="ml-auto rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-500">
            Missing
          </span>
        )}
      </div>

      {entry.hasApiKey && entry.masked && (
        <div className="mt-2 font-mono text-[11px] text-gray-500">{entry.masked}</div>
      )}

      {!editing ? (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50"
          >
            <Pencil className="h-3 w-3" />
            {entry.hasApiKey ? "Replace" : "Set key"}
          </button>
          {entry.hasApiKey && (
            <button
              type="button"
              disabled={busy}
              onClick={handleDelete}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              Remove
            </button>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <input
            type="password"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Paste new API key"
            className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs focus:border-amber-400 focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !draft.trim()}
              onClick={handleSave}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              Save
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setDraft("");
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-60"
            >
              <X className="h-3 w-3" />
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Claude Code OAuth token (super_admin only, system-wide) ──────────────────
//
// Sits next to the vendor API keys because it is also a model-vendor
// credential, just stored on the agent_service container instead of in the
// per-org table. The agent_service persists the token to a file under
// /home/agent/.claude/.oauth-token and exports CLAUDE_CODE_OAUTH_TOKEN into
// process.env at startup, so every spawned `claude` CLI authenticates without
// a manual `su-exec agent claude /login` inside the container.

function ClaudeOauthTokenRow({
  entry,
  reload,
  setError,
}: {
  entry: { configured: boolean; masked: string | null; updatedAt: string | null } | null;
  reload: () => Promise<void>;
  setError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  // While the super_admin-only fetch is in flight we render a placeholder
  // entry so the layout matches the other rows.
  const safeEntry = entry ?? { configured: false, masked: null, updatedAt: null };

  async function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed) {
      setError("OAuth token cannot be empty. Use Remove to clear it.");
      return;
    }
    setBusy(true);
    try {
      await admin.setClaudeOauthToken(trimmed);
      setDraft("");
      setEditing(false);
      await reload();
    } catch (err: any) {
      setError(err?.message ?? "Failed to save token.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    try {
      await admin.deleteClaudeOauthToken();
      setDraft("");
      setEditing(false);
      await reload();
    } catch (err: any) {
      setError(err?.message ?? "Failed to remove token.");
    } finally {
      setBusy(false);
    }
  }

  const tooltip =
    "Claude Code CLI OAuth token. Saved on the agent_service container and " +
    "exported as CLAUDE_CODE_OAUTH_TOKEN so every spawned `claude` invocation " +
    "authenticates without an interactive login inside the container. Generate " +
    "with `claude setup-token` on a machine where you're logged in.";

  return (
    <div className="min-w-0 rounded-xl border border-gray-200/60 bg-white p-4 shadow-glass transition-all duration-200">
      <div className="flex min-w-0 items-center gap-2.5">
        <div
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-gray-200/80 bg-gray-50 text-gray-600"
          title={tooltip}
        >
          <Terminal className="h-4 w-4" />
        </div>
        <span
          className="min-w-0 truncate text-sm font-semibold text-gray-900"
          title={tooltip}
        >
          Claude CLI OAuth
        </span>
        {safeEntry.configured ? (
          <span className="ml-auto rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">
            Configured
          </span>
        ) : (
          <span className="ml-auto rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-500">
            Missing
          </span>
        )}
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-gray-500" title={tooltip}>
        Sets <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[10px]">
          CLAUDE_CODE_OAUTH_TOKEN
        </code> on the agent_service container so the spawned <code>claude</code>{" "}
        CLI skips manual login.
      </p>

      {safeEntry.configured && safeEntry.masked && (
        <div className="mt-2 font-mono text-[11px] text-gray-500">{safeEntry.masked}</div>
      )}

      {!editing ? (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50"
          >
            <Pencil className="h-3 w-3" />
            {safeEntry.configured ? "Replace" : "Set token"}
          </button>
          {safeEntry.configured && (
            <button
              type="button"
              disabled={busy}
              onClick={handleDelete}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              Remove
            </button>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <input
            type="password"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Paste OAuth token"
            className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs focus:border-amber-400 focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !draft.trim()}
              onClick={handleSave}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              Save
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setDraft("");
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-60"
            >
              <X className="h-3 w-3" />
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Codex CLI API key (super_admin only, system-wide) ────────────────────────
//
// Sibling of `ClaudeOauthTokenRow`. The agent_service container persists the
// key to /home/agent/.codex/.api-key and exports it as OPENAI_API_KEY at
// startup so every spawned `codex` CLI authenticates without `codex login`
// inside the container. Token lifecycle is identical to the Claude OAuth row;
// the only differences are wording ("API key" vs "OAuth token") and the env
// var name we surface.

function CodexApiKeyRow({
  entry,
  reload,
  setError,
}: {
  entry: { configured: boolean; masked: string | null; updatedAt: string | null } | null;
  reload: () => Promise<void>;
  setError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const safeEntry = entry ?? { configured: false, masked: null, updatedAt: null };

  async function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed) {
      setError("API key cannot be empty. Use Remove to clear it.");
      return;
    }
    setBusy(true);
    try {
      await admin.setCodexApiKey(trimmed);
      setDraft("");
      setEditing(false);
      await reload();
    } catch (err: any) {
      setError(err?.message ?? "Failed to save key.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    try {
      await admin.deleteCodexApiKey();
      setDraft("");
      setEditing(false);
      await reload();
    } catch (err: any) {
      setError(err?.message ?? "Failed to remove key.");
    } finally {
      setBusy(false);
    }
  }

  const tooltip =
    "Fallback OpenAI API key for the Codex CLI. Saved on the agent_service " +
    "container and exported as OPENAI_API_KEY. Use auth.json for ChatGPT-account " +
    "Codex login; Codex prefers auth.json when both are configured.";

  return (
    <div className="min-w-0 rounded-xl border border-gray-200/60 bg-white p-4 shadow-glass transition-all duration-200">
      <div className="flex min-w-0 items-center gap-2.5">
        <div
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-gray-200/80 bg-gray-50 text-gray-600"
          title={tooltip}
        >
          <Terminal className="h-4 w-4" />
        </div>
        <span
          className="min-w-0 truncate text-sm font-semibold text-gray-900"
          title={tooltip}
        >
          Codex CLI API Key Fallback
        </span>
        {safeEntry.configured ? (
          <span className="ml-auto rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">
            Configured
          </span>
        ) : (
          <span className="ml-auto rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-500">
            Missing
          </span>
        )}
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-gray-500" title={tooltip}>
        Fallback: sets <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[10px]">
          OPENAI_API_KEY
        </code> on the agent_service container so the spawned <code>codex</code>{" "}
        CLI can authenticate when no auth.json is configured.
      </p>

      {safeEntry.configured && safeEntry.masked && (
        <div className="mt-2 font-mono text-[11px] text-gray-500">{safeEntry.masked}</div>
      )}

      {!editing ? (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50"
          >
            <Pencil className="h-3 w-3" />
            {safeEntry.configured ? "Replace" : "Set key"}
          </button>
          {safeEntry.configured && (
            <button
              type="button"
              disabled={busy}
              onClick={handleDelete}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              Remove
            </button>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <input
            type="password"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Paste OpenAI API key"
            className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs focus:border-amber-400 focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !draft.trim()}
              onClick={handleSave}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              Save
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setDraft("");
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-60"
            >
              <X className="h-3 w-3" />
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Codex CLI auth.json (super_admin only, system-wide) ──────────────────────
//
// The ChatGPT-account login path. After a super_admin runs `codex login` on
// their workstation, they paste the contents of `~/.codex/auth.json` here.
// The agent_service writes it to /home/agent/.codex/auth.json (chowned to
// `agent` so the spawned codex can read it directly — codex doesn't accept
// an env-var equivalent for this credential bundle). Codex prefers
// auth.json over OPENAI_API_KEY when both are present.

function CodexAuthJsonRow({
  entry,
  reload,
  setError,
}: {
  entry: {
    configured: boolean;
    accountIdSuffix: string | null;
    accessTokenMasked: string | null;
    hasRefreshToken: boolean;
    hasOpenaiApiKey: boolean;
    lastRefresh: string | null;
    updatedAt: string | null;
  } | null;
  reload: () => Promise<void>;
  setError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const safeEntry =
    entry ?? {
      configured: false,
      accountIdSuffix: null,
      accessTokenMasked: null,
      hasRefreshToken: false,
      hasOpenaiApiKey: false,
      lastRefresh: null,
      updatedAt: null,
    };

  async function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed) {
      setError("auth.json cannot be empty. Paste the full file or use Remove to clear it.");
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError("auth.json must be a JSON object.");
        return;
      }
    } catch (err: any) {
      setError(`auth.json is not valid JSON: ${err?.message ?? err}`);
      return;
    }
    setBusy(true);
    try {
      await admin.setCodexAuthJson(trimmed);
      setDraft("");
      setEditing(false);
      await reload();
    } catch (err: any) {
      setError(err?.message ?? "Failed to save auth.json.");
    } finally {
      setBusy(false);
    }
  }

  async function handleFileSelected(file: File | null) {
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      const trimmed = text.trim();
      if (!trimmed) {
        setError("Selected auth.json file is empty.");
        return;
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          setError("auth.json must be a JSON object.");
          return;
        }
      } catch (err: any) {
        setError(`Selected auth.json is not valid JSON: ${err?.message ?? err}`);
        return;
      }
      setDraft(trimmed);
      setEditing(true);
    } catch (err: any) {
      setError(err?.message ?? "Failed to read auth.json file.");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDelete() {
    setBusy(true);
    try {
      await admin.deleteCodexAuthJson();
      setDraft("");
      setEditing(false);
      await reload();
    } catch (err: any) {
      setError(err?.message ?? "Failed to remove auth.json.");
    } finally {
      setBusy(false);
    }
  }

  const tooltip =
    "Codex CLI ChatGPT-account login. Upload or paste the contents of ~/.codex/auth.json " +
    "from a workstation where you've already run `codex login`. The agent_service " +
    "writes it to /home/agent/.codex/auth.json with owner=agent so the spawned " +
    "codex can read it. Codex prefers this over OPENAI_API_KEY when both exist.";

  return (
    <div className="min-w-0 rounded-xl border border-gray-200/60 bg-white p-4 shadow-glass transition-all duration-200">
      <div className="flex min-w-0 items-center gap-2.5">
        <div
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-gray-200/80 bg-gray-50 text-gray-600"
          title={tooltip}
        >
          <Terminal className="h-4 w-4" />
        </div>
        <span
          className="min-w-0 truncate text-sm font-semibold text-gray-900"
          title={tooltip}
        >
          Codex CLI Login File
        </span>
        {safeEntry.configured ? (
          <span className="ml-auto rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">
            Configured
          </span>
        ) : (
          <span className="ml-auto rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-500">
            Missing
          </span>
        )}
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-gray-500" title={tooltip}>
        Writes <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[10px]">
          /home/agent/.codex/auth.json
        </code>{" "}
        from the contents of your workstation&apos;s file. Run{" "}
        <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[10px]">
          codex login
        </code>{" "}
        locally first, then upload or paste{" "}
        <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[10px]">
          ~/.codex/auth.json
        </code>{" "}
        below.
      </p>

      {safeEntry.configured && (
        <div className="mt-2 space-y-0.5 font-mono text-[11px] text-gray-500">
          {safeEntry.accountIdSuffix && (
            <div>
              <span className="text-gray-400">account:</span>{" "}
              {safeEntry.accountIdSuffix}
            </div>
          )}
          {safeEntry.accessTokenMasked && (
            <div>
              <span className="text-gray-400">access_token:</span>{" "}
              {safeEntry.accessTokenMasked}
            </div>
          )}
          <div>
            <span className="text-gray-400">refresh_token:</span>{" "}
            {safeEntry.hasRefreshToken ? "present" : "—"}
            {"  "}
            <span className="text-gray-400">api_key:</span>{" "}
            {safeEntry.hasOpenaiApiKey ? "present" : "—"}
          </div>
          {safeEntry.lastRefresh && (
            <div>
              <span className="text-gray-400">last_refresh:</span>{" "}
              {safeEntry.lastRefresh}
            </div>
          )}
        </div>
      )}

      {!editing ? (
        <div className="mt-3 flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              void handleFileSelected(e.target.files?.[0] ?? null);
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
            Upload file
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50"
          >
            <FileText className="h-3 w-3" />
            Paste JSON
          </button>
          {safeEntry.configured && (
            <button
              type="button"
              disabled={busy}
              onClick={handleDelete}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              Remove
            </button>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <textarea
            autoFocus
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder='{"OPENAI_API_KEY": null, "tokens": {"id_token": "…", "access_token": "…", "refresh_token": "…", "account_id": "…"}, "last_refresh": "…"}'
            rows={8}
            className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 font-mono text-[11px] focus:border-amber-400 focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !draft.trim()}
              onClick={handleSave}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              Save
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setDraft("");
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-60"
            >
              <X className="h-3 w-3" />
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
