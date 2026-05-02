import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronDown,
  Cpu,
  Loader2,
  Lock,
  LogOut,
  Pencil,
  Plug,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { APP_URL_PREFIX } from "../constants";
import { VendorIcon, vendorColors } from "../components/VendorModelBadge";

/**
 * Platform-admin dashboard: CRUD for the platform-wide catalogs the tenant
 * API can no longer mutate (MCP servers, skills, models). Vendor API keys
 * live PER ORGANIZATION now and are managed from each org's super-admin UI
 * (see AdminPage's Vendor API keys section) — not from here — so one org
 * can never see or rotate another org's credentials.
 *
 * This page is intentionally self-contained — no AuthContext, no AppShell,
 * no shared `admin` API object — because it runs under a disjoint auth
 * surface (`/api/platform`, `platformAdminToken`). Mixing the two would
 * reintroduce the exact confusion we removed when making super_admin
 * strictly tenant-scoped.
 */

const BASE = `${APP_URL_PREFIX}/api/platform`;

function getToken(): string | null {
  return localStorage.getItem("platformAdminToken");
}

async function platformRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error ?? `Request failed (${res.status})`);
    (err as any).status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

interface PlatformMcpServer {
  id: number;
  name: string;
  transport: string;
  command: string;
  args: string[];
  env?: Record<string, string> | null;
}

interface PlatformSkill {
  id: number;
  name: string;
  slug: string | null;
  description: string | null;
  skillText: string;
  locked: boolean;
}

interface PlatformModel {
  id: string;
  name: string;
  slug: string;
  vendor: { id: string; name: string; slug: string } | null;
}

interface PlatformVendor {
  id: string;
  name: string;
  slug: string;
}

interface MeResponse {
  id: string;
  email: string;
  lastLoginAt: string | null;
}

// ─── Reusable UI primitives ────────────────────────────────────────────────

function SectionCard({
  icon,
  title,
  subtitle,
  count,
  actions,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  count?: number;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50 shadow-xl shadow-black/20 ring-1 ring-white/5">
      <header className="flex flex-col gap-3 border-b border-slate-800 bg-slate-900/80 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/30">
            {icon}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold text-slate-100">
                {title}
              </h2>
              {typeof count === "number" && (
                <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-semibold text-slate-300 ring-1 ring-slate-700">
                  {count}
                </span>
              )}
            </div>
            {subtitle && (
              <p className="mt-0.5 truncate text-xs text-slate-400">{subtitle}</p>
            )}
          </div>
        </div>
        {actions && (
          <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>
        )}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
  type = "button",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-2 text-xs font-semibold text-slate-900 shadow-sm transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

function GhostButton({
  children,
  onClick,
  disabled,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

function DangerButton({
  children,
  onClick,
  disabled,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg border border-red-900/70 bg-red-900/30 px-3 py-2 text-xs font-medium text-red-200 transition hover:border-red-700 hover:bg-red-900/50 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
      {children}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-400/60 focus:outline-none focus:ring-2 focus:ring-amber-400/20 ${className}`}
    />
  );
}

function CodeTextarea({
  value,
  onChange,
  placeholder,
  rows = 5,
  minHeight,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  minHeight?: string;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      style={minHeight ? { minHeight } : undefined}
      className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 font-mono text-xs leading-relaxed text-slate-100 placeholder:text-slate-500 focus:border-amber-400/60 focus:outline-none focus:ring-2 focus:ring-amber-400/20"
      spellCheck={false}
    />
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
      <span className="flex-1 break-words">{message}</span>
      {onDismiss && (
        <button onClick={onDismiss} className="flex-shrink-0 text-red-300 hover:text-red-100">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function EmptyState({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-800 bg-slate-950/40 px-4 py-12 text-center">
      <div className="text-slate-600">{icon}</div>
      <div className="text-sm text-slate-500">{label}</div>
    </div>
  );
}

function SearchBar({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative w-full sm:w-64">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-slate-700 bg-slate-950/60 py-1.5 pl-8 pr-3 text-xs text-slate-100 placeholder:text-slate-500 focus:border-amber-400/60 focus:outline-none focus:ring-2 focus:ring-amber-400/20"
      />
    </div>
  );
}

// Custom vendor select with logo support — native <select> can't render icons.
function VendorSelect({
  vendors,
  value,
  onChange,
  placeholder = "Select vendor",
}: {
  vendors: PlatformVendor[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
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

  const selected = vendors.find((v) => v.id === value) ?? null;

  return (
    <div ref={ref} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 hover:border-slate-600 focus:border-amber-400/60 focus:outline-none focus:ring-2 focus:ring-amber-400/20"
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected ? (
            <>
              <span className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md border ${vendorColors[selected.slug] ?? "border-slate-600 bg-slate-800 text-slate-300"}`}>
                <VendorIcon slug={selected.slug} />
              </span>
              <span className="truncate">{selected.name}</span>
              <span className="hidden truncate text-xs text-slate-500 sm:inline">
                · {selected.slug}
              </span>
            </>
          ) : (
            <span className="text-slate-500">{placeholder}</span>
          )}
        </span>
        <ChevronDown
          className={`h-4 w-4 flex-shrink-0 text-slate-400 transition ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-2xl shadow-black/50 ring-1 ring-white/5">
          <ul className="max-h-72 overflow-y-auto py-1">
            {vendors.length === 0 && (
              <li className="px-3 py-2 text-xs text-slate-500">No vendors</li>
            )}
            {vendors.map((v) => {
              const isSelected = v.id === value;
              return (
                <li key={v.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(v.id);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:bg-slate-800 ${
                      isSelected ? "bg-slate-800/70 text-amber-200" : "text-slate-100"
                    }`}
                  >
                    <span
                      className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md border ${
                        vendorColors[v.slug] ??
                        "border-slate-600 bg-slate-800 text-slate-300"
                      }`}
                    >
                      <VendorIcon slug={v.slug} />
                    </span>
                    <span className="truncate">{v.name}</span>
                    <span className="ml-auto truncate text-[11px] text-slate-500">
                      {v.slug}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────

export default function PlatformAdminPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [globalError, setGlobalError] = useState("");

  const [mcpServers, setMcpServers] = useState<PlatformMcpServer[]>([]);
  const [skills, setSkills] = useState<PlatformSkill[]>([]);
  const [models, setModels] = useState<PlatformModel[]>([]);
  const [vendors, setVendors] = useState<PlatformVendor[]>([]);

  const logout = useCallback(() => {
    localStorage.removeItem("platformAdminToken");
    navigate("/platform-admin/login", { replace: true });
  }, [navigate]);

  const refresh = useCallback(async () => {
    try {
      const [m, s, md, v] = await Promise.all([
        platformRequest<PlatformMcpServer[]>("/mcp-servers"),
        platformRequest<PlatformSkill[]>("/skills"),
        platformRequest<PlatformModel[]>("/models"),
        platformRequest<PlatformVendor[]>("/vendors"),
      ]);
      setMcpServers(m);
      setSkills(s);
      setModels(md);
      setVendors(v);
    } catch (err: any) {
      if (err?.status === 401) {
        logout();
        return;
      }
      setGlobalError(err?.message ?? "Failed to load catalogs");
    }
  }, [logout]);

  useEffect(() => {
    if (!getToken()) {
      navigate("/platform-admin/login", { replace: true });
      return;
    }
    (async () => {
      try {
        const who = await platformRequest<MeResponse>("/auth/me");
        setMe(who);
        await refresh();
      } catch (err: any) {
        if (err?.status === 401) {
          logout();
          return;
        }
        setGlobalError(err?.message ?? "Failed to verify session");
      } finally {
        setAuthChecked(true);
      }
    })();
  }, [navigate, refresh, logout]);

  if (!authChecked) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950">
        <Loader2 className="h-8 w-8 animate-spin text-amber-400" />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900 text-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-amber-500/20 ring-1 ring-amber-400/40">
              <ShieldCheck className="h-5 w-5 text-amber-300" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-100">
                Platform admin
              </div>
              <div className="truncate text-xs text-slate-400">
                {me?.email ?? "Signed in"}
              </div>
            </div>
          </div>
          <button
            onClick={logout}
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-800"
          >
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {globalError && (
          <div className="mb-6">
            <ErrorBanner
              message={globalError}
              onDismiss={() => setGlobalError("")}
            />
          </div>
        )}

        <div className="flex flex-col gap-6">
          <McpServersSection servers={mcpServers} refresh={refresh} />
          <SkillsSection skills={skills} refresh={refresh} />
          <ModelsSection models={models} vendors={vendors} refresh={refresh} />
        </div>
      </div>
    </main>
  );
}

// ─── MCP servers ───────────────────────────────────────────────────────────

function McpServersSection({
  servers,
  refresh,
}: {
  servers: PlatformMcpServer[];
  refresh: () => Promise<void>;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.command.toLowerCase().includes(q) ||
        (s.args ?? []).some((a) => a.toLowerCase().includes(q)),
    );
  }, [servers, query]);

  function resetForm() {
    setName("");
    setTransport("stdio");
    setCommand("");
    setArgsText("");
    setEnvText("");
    setErr("");
  }

  async function handleCreate() {
    setErr("");
    setBusy(true);
    try {
      const args = argsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const env = envText.trim() ? JSON.parse(envText) : null;
      await platformRequest("/mcp-servers", {
        method: "POST",
        body: JSON.stringify({ name, transport, command, args, env }),
      });
      resetForm();
      setShowAdd(false);
      await refresh();
    } catch (e: any) {
      setErr(e?.message ?? "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this MCP server?")) return;
    try {
      await platformRequest(`/mcp-servers/${id}`, { method: "DELETE" });
      await refresh();
    } catch (e: any) {
      alert(e?.message ?? "Failed to delete");
    }
  }

  return (
    <SectionCard
      icon={<Plug className="h-5 w-5" />}
      title="MCP servers"
      subtitle="Platform-wide MCP registry."
      count={servers.length}
      actions={
        <>
          <SearchBar
            value={query}
            onChange={setQuery}
            placeholder="Search servers"
          />
          <PrimaryButton onClick={() => setShowAdd((v) => !v)}>
            {showAdd ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {showAdd ? "Cancel" : "Add server"}
          </PrimaryButton>
        </>
      }
    >
      {showAdd && (
        <div className="mb-4 rounded-xl border border-amber-400/20 bg-amber-500/[0.04] p-4 ring-1 ring-amber-400/10">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-amber-300">
            New MCP server
          </div>
          {err && (
            <div className="mb-3">
              <ErrorBanner message={err} onDismiss={() => setErr("")} />
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <FieldLabel>Name (unique)</FieldLabel>
              <TextInput value={name} onChange={setName} placeholder="filesystem" />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>Transport</FieldLabel>
              <TextInput
                value={transport}
                onChange={setTransport}
                placeholder="stdio"
              />
            </div>
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <FieldLabel>Executable</FieldLabel>
              <TextInput value={command} onChange={setCommand} placeholder="npx" />
            </div>
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <FieldLabel>Args (one per line)</FieldLabel>
              <CodeTextarea
                value={argsText}
                onChange={setArgsText}
                placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/app/data"}
                rows={5}
              />
            </div>
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <FieldLabel>Env (JSON, optional)</FieldLabel>
              <CodeTextarea
                value={envText}
                onChange={setEnvText}
                placeholder='{"GITHUB_TOKEN":"…"}'
                rows={4}
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <GhostButton
              onClick={() => {
                resetForm();
                setShowAdd(false);
              }}
            >
              Cancel
            </GhostButton>
            <PrimaryButton
              disabled={busy || !name || !command}
              onClick={handleCreate}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Create
            </PrimaryButton>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Plug className="h-8 w-8" />}
          label={
            servers.length === 0
              ? "No MCP servers registered yet."
              : "No servers match your search."
          }
        />
      ) : (
        <div className="space-y-2.5">
          {filtered.map((s) => (
            <McpServerRow
              key={s.id}
              server={s}
              refresh={refresh}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function McpServerRow({
  server,
  refresh,
  onDelete,
}: {
  server: PlatformMcpServer;
  refresh: () => Promise<void>;
  onDelete: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [command, setCommand] = useState(server.command);
  const [argsText, setArgsText] = useState((server.args ?? []).join("\n"));
  const [envText, setEnvText] = useState(
    server.env ? JSON.stringify(server.env, null, 2) : "",
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Reset local form state when entering edit mode (e.g. after refresh).
  useEffect(() => {
    if (editing) {
      setCommand(server.command);
      setArgsText((server.args ?? []).join("\n"));
      setEnvText(server.env ? JSON.stringify(server.env, null, 2) : "");
      setErr("");
    }
  }, [editing, server]);

  async function handleSave() {
    setErr("");
    setBusy(true);
    try {
      const args = argsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const env = envText.trim() ? JSON.parse(envText) : null;
      await platformRequest(`/mcp-servers/${server.id}`, {
        method: "PATCH",
        body: JSON.stringify({ command, args, env }),
      });
      setEditing(false);
      await refresh();
    } catch (e: any) {
      setErr(e?.message ?? "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60 transition hover:border-slate-700">
      <div className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-slate-800 text-slate-300 ring-1 ring-slate-700">
            <Plug className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-semibold text-slate-100">
                {server.name}
              </span>
              <span className="rounded-md bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-300 ring-1 ring-slate-700">
                {server.transport}
              </span>
            </div>
            <div className="mt-1.5 overflow-x-auto rounded-md bg-slate-950/80 px-2.5 py-1.5 ring-1 ring-slate-800">
              <code className="whitespace-nowrap font-mono text-[11px] text-slate-300">
                {server.command} {(server.args ?? []).join(" ")}
              </code>
            </div>
            {server.env && Object.keys(server.env).length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {Object.keys(server.env).map((k) => (
                  <span
                    key={k}
                    className="rounded-md bg-slate-800/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-400 ring-1 ring-slate-700"
                  >
                    {k}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <GhostButton onClick={() => setEditing((v) => !v)}>
            {editing ? (
              <>
                <X className="h-3.5 w-3.5" /> Cancel
              </>
            ) : (
              <>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </>
            )}
          </GhostButton>
          <DangerButton onClick={() => onDelete(server.id)}>
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </DangerButton>
        </div>
      </div>

      {editing && (
        <div className="border-t border-slate-800 bg-slate-950/40 p-4">
          {err && (
            <div className="mb-3">
              <ErrorBanner message={err} onDismiss={() => setErr("")} />
            </div>
          )}
          <div className="grid grid-cols-1 gap-3">
            <div className="flex flex-col gap-1.5">
              <FieldLabel>Executable</FieldLabel>
              <TextInput value={command} onChange={setCommand} />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>Args (one per line)</FieldLabel>
              <CodeTextarea value={argsText} onChange={setArgsText} rows={5} />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>Env (JSON, optional)</FieldLabel>
              <CodeTextarea
                value={envText}
                onChange={setEnvText}
                rows={5}
                placeholder='{"KEY":"value"}'
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <GhostButton onClick={() => setEditing(false)}>Cancel</GhostButton>
            <PrimaryButton onClick={handleSave} disabled={busy}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save
            </PrimaryButton>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Skills ────────────────────────────────────────────────────────────────

function SkillsSection({
  skills,
  refresh,
}: {
  skills: PlatformSkill[];
  refresh: () => Promise<void>;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [skillText, setSkillText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");
  const [filterLocked, setFilterLocked] = useState<"all" | "editable" | "locked">("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => {
      if (filterLocked === "editable" && s.locked) return false;
      if (filterLocked === "locked" && !s.locked) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        (s.slug ?? "").toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [skills, query, filterLocked]);

  function resetForm() {
    setName("");
    setSlug("");
    setDescription("");
    setSkillText("");
    setErr("");
  }

  async function handleCreate() {
    setErr("");
    setBusy(true);
    try {
      await platformRequest("/skills", {
        method: "POST",
        body: JSON.stringify({
          name,
          slug: slug || null,
          description: description || null,
          skillText,
        }),
      });
      resetForm();
      setShowAdd(false);
      await refresh();
    } catch (e: any) {
      setErr(e?.message ?? "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this skill?")) return;
    try {
      await platformRequest(`/skills/${id}`, { method: "DELETE" });
      await refresh();
    } catch (e: any) {
      alert(e?.message ?? "Failed");
    }
  }

  const lockedCount = skills.filter((s) => s.locked).length;

  return (
    <SectionCard
      icon={<Sparkles className="h-5 w-5" />}
      title="Skills library"
      subtitle={`${lockedCount} locked (seed-managed) · ${skills.length - lockedCount} editable`}
      count={skills.length}
      actions={
        <>
          <SearchBar
            value={query}
            onChange={setQuery}
            placeholder="Search skills"
          />
          <PrimaryButton onClick={() => setShowAdd((v) => !v)}>
            {showAdd ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {showAdd ? "Cancel" : "Add skill"}
          </PrimaryButton>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap gap-1.5">
        {(["all", "editable", "locked"] as const).map((opt) => (
          <button
            key={opt}
            onClick={() => setFilterLocked(opt)}
            className={`rounded-full px-3 py-1 text-[11px] font-medium transition ${
              filterLocked === opt
                ? "bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/40"
                : "bg-slate-800 text-slate-400 ring-1 ring-slate-700 hover:bg-slate-700/70"
            }`}
          >
            {opt === "all" ? "All" : opt === "editable" ? "Editable only" : "Locked only"}
          </button>
        ))}
      </div>

      {showAdd && (
        <div className="mb-4 rounded-xl border border-amber-400/20 bg-amber-500/[0.04] p-4 ring-1 ring-amber-400/10">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-amber-300">
            New skill
          </div>
          {err && (
            <div className="mb-3">
              <ErrorBanner message={err} onDismiss={() => setErr("")} />
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <FieldLabel>Name</FieldLabel>
              <TextInput value={name} onChange={setName} placeholder="My skill" />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>Slug (optional)</FieldLabel>
              <TextInput value={slug} onChange={setSlug} placeholder="my-skill" />
            </div>
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <FieldLabel>Description</FieldLabel>
              <TextInput
                value={description}
                onChange={setDescription}
                placeholder="One-line summary shown in the picker"
              />
            </div>
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <FieldLabel>Skill text (full prompt)</FieldLabel>
              <CodeTextarea
                value={skillText}
                onChange={setSkillText}
                placeholder="# My skill&#10;&#10;Markdown body that's injected into the agent's system prompt…"
                rows={18}
                minHeight="420px"
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <GhostButton
              onClick={() => {
                resetForm();
                setShowAdd(false);
              }}
            >
              Cancel
            </GhostButton>
            <PrimaryButton
              disabled={busy || !name || !skillText}
              onClick={handleCreate}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Create
            </PrimaryButton>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Sparkles className="h-8 w-8" />}
          label={
            skills.length === 0
              ? "No skills in the library yet."
              : "No skills match your filters."
          }
        />
      ) : (
        <div className="space-y-2.5">
          {filtered.map((s) => (
            <SkillRow
              key={s.id}
              skill={s}
              refresh={refresh}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function SkillRow({
  skill,
  refresh,
  onDelete,
}: {
  skill: PlatformSkill;
  refresh: () => Promise<void>;
  onDelete: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description ?? "");
  const [skillText, setSkillText] = useState(skill.skillText);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (editing) {
      setName(skill.name);
      setDescription(skill.description ?? "");
      setSkillText(skill.skillText);
      setErr("");
    }
  }, [editing, skill]);

  async function handleSave() {
    setErr("");
    setBusy(true);
    try {
      await platformRequest(`/skills/${skill.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          description: description || null,
          skillText,
        }),
      });
      setEditing(false);
      await refresh();
    } catch (e: any) {
      setErr(e?.message ?? "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60 transition hover:border-slate-700">
      <div className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div
            className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ring-1 ${
              skill.locked
                ? "bg-slate-800 text-slate-500 ring-slate-700"
                : "bg-amber-500/15 text-amber-300 ring-amber-400/30"
            }`}
          >
            {skill.locked ? <Lock className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-semibold text-slate-100">
                {skill.name}
              </span>
              {skill.locked && (
                <span className="inline-flex items-center gap-1 rounded-md bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-300 ring-1 ring-slate-700">
                  <Lock className="h-2.5 w-2.5" /> Locked
                </span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-xs">
              <code className="truncate rounded bg-slate-800/70 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">
                {skill.slug ?? "—"}
              </code>
            </div>
            {skill.description && (
              <p className="mt-1.5 line-clamp-2 text-xs text-slate-400">
                {skill.description}
              </p>
            )}
          </div>
        </div>
        {!skill.locked && (
          <div className="flex flex-shrink-0 items-center gap-2">
            <GhostButton onClick={() => setEditing((v) => !v)}>
              {editing ? (
                <>
                  <X className="h-3.5 w-3.5" /> Cancel
                </>
              ) : (
                <>
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </>
              )}
            </GhostButton>
            <DangerButton onClick={() => onDelete(skill.id)}>
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </DangerButton>
          </div>
        )}
      </div>

      {editing && (
        <div className="border-t border-slate-800 bg-slate-950/40 p-4">
          {err && (
            <div className="mb-3">
              <ErrorBanner message={err} onDismiss={() => setErr("")} />
            </div>
          )}
          <div className="grid grid-cols-1 gap-3">
            <div className="flex flex-col gap-1.5">
              <FieldLabel>Name</FieldLabel>
              <TextInput value={name} onChange={setName} />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>Description</FieldLabel>
              <TextInput
                value={description}
                onChange={setDescription}
                placeholder="One-line summary shown in the picker"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <FieldLabel>Skill text (markdown)</FieldLabel>
                <span className="text-[10px] text-slate-500">
                  {skillText.length.toLocaleString()} chars · {skillText.split("\n").length} lines
                </span>
              </div>
              <CodeTextarea
                value={skillText}
                onChange={setSkillText}
                rows={24}
                minHeight="560px"
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <GhostButton onClick={() => setEditing(false)}>Cancel</GhostButton>
            <PrimaryButton onClick={handleSave} disabled={busy}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save
            </PrimaryButton>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Models ────────────────────────────────────────────────────────────────

function ModelsSection({
  models,
  vendors,
  refresh,
}: {
  models: PlatformModel[];
  vendors: PlatformVendor[];
  refresh: () => Promise<void>;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [vendorId, setVendorId] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");
  const [vendorFilter, setVendorFilter] = useState<string>("all");

  // Google models are auto-discovered, so we don't let the UI add them manually.
  const selectableVendors = useMemo(
    () => vendors.filter((v) => v.slug !== "google"),
    [vendors],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models.filter((m) => {
      if (vendorFilter !== "all" && m.vendor?.slug !== vendorFilter) return false;
      if (!q) return true;
      return (
        m.name.toLowerCase().includes(q) ||
        m.slug.toLowerCase().includes(q) ||
        (m.vendor?.name ?? "").toLowerCase().includes(q)
      );
    });
  }, [models, query, vendorFilter]);

  // Distinct vendors actually present in models — used for filter chips.
  const vendorChips = useMemo(() => {
    const seen = new Map<string, PlatformVendor>();
    for (const m of models) {
      if (m.vendor && !seen.has(m.vendor.slug)) {
        seen.set(m.vendor.slug, m.vendor);
      }
    }
    return Array.from(seen.values());
  }, [models]);

  function resetForm() {
    setVendorId("");
    setName("");
    setSlug("");
    setErr("");
  }

  async function handleCreate() {
    setErr("");
    setBusy(true);
    try {
      await platformRequest("/models", {
        method: "POST",
        body: JSON.stringify({ vendorId, name, slug }),
      });
      resetForm();
      setShowAdd(false);
      await refresh();
    } catch (e: any) {
      setErr(e?.message ?? "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this model?")) return;
    try {
      await platformRequest(`/models/${id}`, { method: "DELETE" });
      await refresh();
    } catch (e: any) {
      alert(e?.message ?? "Failed");
    }
  }

  return (
    <SectionCard
      icon={<Cpu className="h-5 w-5" />}
      title="Models"
      subtitle="Platform model catalog. Google models are discovered dynamically."
      count={models.length}
      actions={
        <>
          <SearchBar
            value={query}
            onChange={setQuery}
            placeholder="Search models"
          />
          <PrimaryButton onClick={() => setShowAdd((v) => !v)}>
            {showAdd ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {showAdd ? "Cancel" : "Add model"}
          </PrimaryButton>
        </>
      }
    >
      {vendorChips.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          <button
            onClick={() => setVendorFilter("all")}
            className={`rounded-full px-3 py-1 text-[11px] font-medium transition ${
              vendorFilter === "all"
                ? "bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/40"
                : "bg-slate-800 text-slate-400 ring-1 ring-slate-700 hover:bg-slate-700/70"
            }`}
          >
            All vendors
          </button>
          {vendorChips.map((v) => {
            const active = vendorFilter === v.slug;
            return (
              <button
                key={v.slug}
                onClick={() => setVendorFilter(v.slug)}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                  active
                    ? "bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/40"
                    : "bg-slate-800 text-slate-400 ring-1 ring-slate-700 hover:bg-slate-700/70"
                }`}
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded ${
                    vendorColors[v.slug] ?? "bg-slate-700 text-slate-300"
                  }`}
                >
                  <VendorIcon slug={v.slug} />
                </span>
                {v.name}
              </button>
            );
          })}
        </div>
      )}

      {showAdd && (
        <div className="mb-4 rounded-xl border border-amber-400/20 bg-amber-500/[0.04] p-4 ring-1 ring-amber-400/10">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-amber-300">
            New model
          </div>
          {err && (
            <div className="mb-3">
              <ErrorBanner message={err} onDismiss={() => setErr("")} />
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <FieldLabel>Vendor</FieldLabel>
              <VendorSelect
                vendors={selectableVendors}
                value={vendorId}
                onChange={setVendorId}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>Display name</FieldLabel>
              <TextInput
                value={name}
                onChange={setName}
                placeholder="Claude Sonnet 4.6"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>Slug (API model id)</FieldLabel>
              <TextInput
                value={slug}
                onChange={setSlug}
                placeholder="claude-sonnet-4-6"
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <GhostButton
              onClick={() => {
                resetForm();
                setShowAdd(false);
              }}
            >
              Cancel
            </GhostButton>
            <PrimaryButton
              disabled={busy || !vendorId || !name || !slug}
              onClick={handleCreate}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Create
            </PrimaryButton>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Cpu className="h-8 w-8" />}
          label={
            models.length === 0
              ? "No models in the catalog yet."
              : "No models match your filters."
          }
        />
      ) : (
        <div className="space-y-2.5">
          {filtered.map((m) => (
            <ModelRow key={m.id} model={m} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function ModelRow({
  model,
  onDelete,
}: {
  model: PlatformModel;
  onDelete: (id: string) => void;
}) {
  const vendorSlug = model.vendor?.slug ?? "unknown";
  const swatch =
    vendorColors[vendorSlug] ??
    "bg-slate-800 text-slate-300 border-slate-700";

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-3.5 transition hover:border-slate-700 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div
          className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border ${swatch}`}
          title={model.vendor?.name ?? "Unknown vendor"}
        >
          <VendorIcon slug={vendorSlug} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-slate-100">
              {model.name}
            </span>
            {model.vendor && (
              <span className="rounded-md bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-slate-300 ring-1 ring-slate-700">
                {model.vendor.name}
              </span>
            )}
          </div>
          <code className="mt-0.5 block truncate font-mono text-[11px] text-slate-400">
            {model.slug}
          </code>
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center justify-end">
        <DangerButton onClick={() => onDelete(model.id)}>
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </DangerButton>
      </div>
    </div>
  );
}
