import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LogOut, Plus, Trash2, Save, Loader2, ShieldCheck } from "lucide-react";
import { APP_URL_PREFIX } from "../constants";

/**
 * Platform-admin dashboard: CRUD for the platform-wide catalogs the tenant
 * API can no longer mutate (MCP servers, skills, models, vendor API keys).
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
  hasApiKey: boolean;
}

interface MeResponse {
  id: string;
  email: string;
  lastLoginAt: string | null;
}

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
      <main className="flex min-h-screen items-center justify-center bg-slate-900">
        <Loader2 className="h-8 w-8 animate-spin text-amber-400" />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-800 bg-slate-900/90 px-6 py-4 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/20 ring-1 ring-amber-400/40">
            <ShieldCheck className="h-5 w-5 text-amber-300" />
          </div>
          <div>
            <div className="text-sm font-semibold">Platform admin</div>
            <div className="text-xs text-slate-400">
              {me?.email ?? "Signed in"}
            </div>
          </div>
        </div>
        <button
          onClick={logout}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
        >
          <LogOut className="h-3.5 w-3.5" /> Sign out
        </button>
      </header>

      {globalError && (
        <div className="mx-auto mt-6 max-w-5xl rounded-xl bg-red-900/40 px-4 py-3 text-sm text-red-200 ring-1 ring-red-800/70">
          {globalError}
        </div>
      )}

      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-8">
        <McpServersSection servers={mcpServers} refresh={refresh} />
        <SkillsSection skills={skills} refresh={refresh} />
        <VendorsSection vendors={vendors} refresh={refresh} />
        <ModelsSection models={models} vendors={vendors} refresh={refresh} />
      </div>
    </main>
  );
}

// ── MCP servers ────────────────────────────────────────────────────────────

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
      setName("");
      setCommand("");
      setArgsText("");
      setEnvText("");
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
    await platformRequest(`/mcp-servers/${id}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">MCP servers</h2>
          <p className="text-xs text-slate-400">Platform-wide MCP registry.</p>
        </div>
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-900 hover:bg-amber-400"
        >
          <Plus className="h-3.5 w-3.5" />
          {showAdd ? "Cancel" : "Add server"}
        </button>
      </div>

      {showAdd && (
        <div className="mb-4 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
          {err && (
            <div className="mb-3 rounded-lg bg-red-900/40 px-3 py-2 text-xs text-red-200">
              {err}
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name (unique)"
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
            />
            <input
              value={transport}
              onChange={(e) => setTransport(e.target.value)}
              placeholder="Transport (e.g. stdio)"
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
            />
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Executable (e.g. npx)"
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm md:col-span-2"
            />
            <textarea
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder="Args (one per line)"
              rows={3}
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 font-mono text-xs md:col-span-2"
            />
            <textarea
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder='Env JSON (optional, e.g. {"KEY":"value"})'
              rows={2}
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 font-mono text-xs md:col-span-2"
            />
          </div>
          <div className="mt-3 flex justify-end">
            <button
              disabled={busy || !name || !command}
              onClick={handleCreate}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-900 hover:bg-amber-400 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Create
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {servers.length === 0 && (
          <div className="text-sm text-slate-500">No MCP servers registered.</div>
        )}
        {servers.map((s) => (
          <McpServerRow key={s.id} server={s} refresh={refresh} onDelete={handleDelete} />
        ))}
      </div>
    </section>
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

  async function handleSave() {
    setErr("");
    setBusy(true);
    try {
      const args = argsText.split("\n").map((s) => s.trim()).filter(Boolean);
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
    <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">{server.name}</div>
          <div className="font-mono text-xs text-slate-400">
            {server.transport} · {server.command} {(server.args ?? []).join(" ")}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setEditing((v) => !v)}
            className="rounded-md border border-slate-600 bg-slate-800 px-2 py-1 text-xs hover:bg-slate-700"
          >
            {editing ? "Cancel" : "Edit"}
          </button>
          <button
            onClick={() => onDelete(server.id)}
            className="inline-flex items-center gap-1 rounded-md border border-red-900/70 bg-red-900/40 px-2 py-1 text-xs text-red-200 hover:bg-red-900/60"
          >
            <Trash2 className="h-3 w-3" /> Delete
          </button>
        </div>
      </div>

      {editing && (
        <div className="mt-3 space-y-2">
          {err && (
            <div className="rounded-lg bg-red-900/40 px-3 py-2 text-xs text-red-200">
              {err}
            </div>
          )}
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
          />
          <textarea
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 font-mono text-xs"
            placeholder="Args (one per line)"
          />
          <textarea
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 font-mono text-xs"
            placeholder='Env JSON (e.g. {"KEY":"value"})'
          />
          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-900 hover:bg-amber-400 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Skills ─────────────────────────────────────────────────────────────────

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
      setName("");
      setSlug("");
      setDescription("");
      setSkillText("");
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

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Skills library</h2>
          <p className="text-xs text-slate-400">
            Platform catalog. Locked skills are seed-managed and cannot be edited.
          </p>
        </div>
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-900 hover:bg-amber-400"
        >
          <Plus className="h-3.5 w-3.5" />
          {showAdd ? "Cancel" : "Add skill"}
        </button>
      </div>

      {showAdd && (
        <div className="mb-4 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
          {err && (
            <div className="mb-3 rounded-lg bg-red-900/40 px-3 py-2 text-xs text-red-200">
              {err}
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
            />
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="Slug (optional)"
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
            />
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description"
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm md:col-span-2"
            />
            <textarea
              value={skillText}
              onChange={(e) => setSkillText(e.target.value)}
              placeholder="Skill text (full prompt)"
              rows={6}
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 font-mono text-xs md:col-span-2"
            />
          </div>
          <div className="mt-3 flex justify-end">
            <button
              disabled={busy || !name || !skillText}
              onClick={handleCreate}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-900 hover:bg-amber-400 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Create
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {skills.length === 0 && (
          <div className="text-sm text-slate-500">No skills.</div>
        )}
        {skills.map((s) => (
          <SkillRow key={s.id} skill={s} refresh={refresh} onDelete={handleDelete} />
        ))}
      </div>
    </section>
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
    <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{skill.name}</span>
            {skill.locked && (
              <span className="rounded-md bg-slate-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-300">
                locked
              </span>
            )}
          </div>
          <div className="text-xs text-slate-400">
            {skill.slug ?? "—"} · {skill.description ?? "no description"}
          </div>
        </div>
        {!skill.locked && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setEditing((v) => !v)}
              className="rounded-md border border-slate-600 bg-slate-800 px-2 py-1 text-xs hover:bg-slate-700"
            >
              {editing ? "Cancel" : "Edit"}
            </button>
            <button
              onClick={() => onDelete(skill.id)}
              className="inline-flex items-center gap-1 rounded-md border border-red-900/70 bg-red-900/40 px-2 py-1 text-xs text-red-200 hover:bg-red-900/60"
            >
              <Trash2 className="h-3 w-3" /> Delete
            </button>
          </div>
        )}
      </div>

      {editing && (
        <div className="mt-3 space-y-2">
          {err && (
            <div className="rounded-lg bg-red-900/40 px-3 py-2 text-xs text-red-200">
              {err}
            </div>
          )}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description"
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
          />
          <textarea
            value={skillText}
            onChange={(e) => setSkillText(e.target.value)}
            rows={8}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 font-mono text-xs"
          />
          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-900 hover:bg-amber-400 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Vendors (API keys) ─────────────────────────────────────────────────────

function VendorsSection({
  vendors,
  refresh,
}: {
  vendors: PlatformVendor[];
  refresh: () => Promise<void>;
}) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Vendor API keys</h2>
        <p className="text-xs text-slate-400">
          Keys are stored encrypted server-side; the plaintext is never read back.
          Leave blank and save to clear.
        </p>
      </div>
      <div className="space-y-2">
        {vendors.map((v) => (
          <VendorRow key={v.id} vendor={v} refresh={refresh} />
        ))}
      </div>
    </section>
  );
}

function VendorRow({
  vendor,
  refresh,
}: {
  vendor: PlatformVendor;
  refresh: () => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function handleSave() {
    setErr("");
    setBusy(true);
    try {
      await platformRequest(`/vendors/${vendor.id}/api-key`, {
        method: "PATCH",
        body: JSON.stringify({ apiKey }),
      });
      setApiKey("");
      await refresh();
    } catch (e: any) {
      setErr(e?.message ?? "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-800/40 p-3">
      <div className="min-w-0">
        <div className="text-sm font-semibold">{vendor.name}</div>
        <div className="text-xs text-slate-400">
          {vendor.slug} · {vendor.hasApiKey ? "key set" : "no key"}
        </div>
        {err && <div className="mt-1 text-xs text-red-300">{err}</div>}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="new key (blank = clear)"
          className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-xs"
        />
        <button
          onClick={handleSave}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-900 hover:bg-amber-400 disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save
        </button>
      </div>
    </div>
  );
}

// ── Models ─────────────────────────────────────────────────────────────────

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

  // Google models are auto-discovered, so we don't let the UI add them manually.
  const selectableVendors = vendors.filter((v) => v.slug !== "google");

  async function handleCreate() {
    setErr("");
    setBusy(true);
    try {
      await platformRequest("/models", {
        method: "POST",
        body: JSON.stringify({ vendorId, name, slug }),
      });
      setVendorId("");
      setName("");
      setSlug("");
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
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Models</h2>
          <p className="text-xs text-slate-400">
            Platform model catalog. Google models are discovered dynamically.
          </p>
        </div>
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-900 hover:bg-amber-400"
        >
          <Plus className="h-3.5 w-3.5" />
          {showAdd ? "Cancel" : "Add model"}
        </button>
      </div>

      {showAdd && (
        <div className="mb-4 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
          {err && (
            <div className="mb-3 rounded-lg bg-red-900/40 px-3 py-2 text-xs text-red-200">
              {err}
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <select
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
            >
              <option value="">Select vendor</option>
              {selectableVendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Model name"
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
            />
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="Slug (API model id)"
              className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
            />
          </div>
          <div className="mt-3 flex justify-end">
            <button
              disabled={busy || !vendorId || !name || !slug}
              onClick={handleCreate}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-900 hover:bg-amber-400 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Create
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {models.length === 0 && (
          <div className="text-sm text-slate-500">No models.</div>
        )}
        {models.map((m) => (
          <div
            key={m.id}
            className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-800/40 p-3"
          >
            <div>
              <div className="text-sm font-semibold">{m.name}</div>
              <div className="text-xs text-slate-400">
                {m.vendor?.name ?? "—"} · {m.slug}
              </div>
            </div>
            <button
              onClick={() => handleDelete(m.id)}
              className="inline-flex items-center gap-1 rounded-md border border-red-900/70 bg-red-900/40 px-2 py-1 text-xs text-red-200 hover:bg-red-900/60"
            >
              <Trash2 className="h-3 w-3" /> Delete
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
