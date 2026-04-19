import { useEffect, useState } from "react";
import { ShieldCheck, Loader2, Users2 } from "lucide-react";
import {
  admin,
  ALL_GOOGLE_SCOPES,
  type GoogleScope,
  type AdminAgent,
} from "../api";
import { useToast } from "./Toast";

interface Props {
  agents: AdminAgent[];
}

interface GoogleUser {
  id: number;
  displayName: string | null;
  userName: string;
  lastLoginAt: string | null;
}

type ScopeMatrix = Map<number, Set<GoogleScope>>;

const SCOPE_GROUPS: {
  title: string;
  scopes: { scope: GoogleScope; label: string }[];
}[] = [
  {
    title: "Calendar",
    scopes: [
      { scope: "calendar.read", label: "Read events" },
      { scope: "calendar.write", label: "Create events" },
    ],
  },
  {
    title: "Drive",
    scopes: [
      { scope: "drive.read", label: "Read files" },
      { scope: "drive.write", label: "Create files" },
    ],
  },
  {
    title: "Gmail",
    scopes: [
      { scope: "gmail.read", label: "Read messages" },
      { scope: "gmail.send", label: "Send messages" },
    ],
  },
];

/**
 * Super-admin section: per-(agent, user) grants for Google Calendar / Drive /
 * Gmail operations. Permission is fine-grained — each scope is row-keyed on
 * (agent_id, subject_user_id, scope) — and the tools refuse calls that
 * aren't explicitly allowed.
 */
export default function GooglePermissionsSection({ agents }: Props) {
  const toast = useToast();
  const primaryAgents = agents.filter((a) => a.type === "primary");

  const [selectedAgentId, setSelectedAgentId] = useState<string>(
    primaryAgents[0]?.id ?? "",
  );
  const [googleUsers, setGoogleUsers] = useState<GoogleUser[]>([]);
  const [matrix, setMatrix] = useState<ScopeMatrix>(new Map());
  const [loading, setLoading] = useState(true);
  const [busyCell, setBusyCell] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    admin
      .getGoogleUsers()
      .then((rows) => {
        if (!cancelled) setGoogleUsers(rows);
      })
      .catch((err: any) =>
        toast.toast(err?.message ?? "Failed to load Google users", "error"),
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [toast]);

  useEffect(() => {
    if (!selectedAgentId) {
      setMatrix(new Map());
      return;
    }
    let cancelled = false;
    admin
      .getAgentUserScopes(selectedAgentId)
      .then((rows) => {
        if (cancelled) return;
        const m: ScopeMatrix = new Map();
        for (const r of rows) m.set(r.subjectUserId, new Set(r.scopes));
        setMatrix(m);
      })
      .catch((err: any) =>
        toast.toast(err?.message ?? "Failed to load scopes", "error"),
      );
    return () => {
      cancelled = true;
    };
  }, [selectedAgentId, toast]);

  async function toggle(subjectUserId: number, scope: GoogleScope) {
    if (!selectedAgentId) return;
    const key = `${subjectUserId}:${scope}`;
    const existing = matrix.get(subjectUserId);
    const has = existing?.has(scope) ?? false;
    setBusyCell(key);
    try {
      if (has) {
        await admin.revokeAgentUserScope(selectedAgentId, subjectUserId, scope);
      } else {
        await admin.grantAgentUserScope(selectedAgentId, subjectUserId, scope);
      }
      // Optimistic state update.
      setMatrix((prev) => {
        const next = new Map(prev);
        const set = new Set(next.get(subjectUserId) ?? []);
        if (has) set.delete(scope);
        else set.add(scope);
        if (set.size === 0) next.delete(subjectUserId);
        else next.set(subjectUserId, set);
        return next;
      });
    } catch (err: any) {
      toast.toast(err?.message ?? "Permission update failed", "error");
    } finally {
      setBusyCell(null);
    }
  }

  return (
    <div className="mb-4">
      <h3 className="mb-2.5 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-500">
        <ShieldCheck className="h-3.5 w-3.5 text-indigo-500" />
        Google Permissions
        <span className="ml-1 text-[9px] font-normal normal-case text-gray-400">
          per-(agent, user, scope) grants
        </span>
      </h3>

      {primaryAgents.length === 0 ? (
        <p className="py-2 text-xs text-gray-400">
          No primary agents to configure.
        </p>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          {/* Agent picker */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <label className="text-xs font-semibold text-gray-600">
              Agent:
            </label>
            <select
              value={selectedAgentId}
              onChange={(e) => setSelectedAgentId(e.target.value)}
              className="rounded border border-gray-300 px-2 py-1 text-xs"
            >
              {primaryAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.agentName ?? a.definition ?? a.id}
                </option>
              ))}
            </select>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading Google users…
            </div>
          ) : googleUsers.length === 0 ? (
            <div className="flex items-center gap-2 rounded border border-dashed border-gray-300 px-3 py-4 text-xs text-gray-500">
              <Users2 className="h-3.5 w-3.5" />
              No users in this organization have signed in with Google yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-xs">
                <thead className="border-b border-gray-200 text-[10px] uppercase tracking-wider text-gray-500">
                  <tr>
                    <th className="py-2 pr-3 font-semibold">Subject user</th>
                    {SCOPE_GROUPS.map((grp) =>
                      grp.scopes.map((s) => (
                        <th
                          key={s.scope}
                          className="px-2 py-2 text-center font-semibold"
                          title={s.scope}
                        >
                          <div className="text-[9px] font-normal text-gray-400">
                            {grp.title}
                          </div>
                          {s.label}
                        </th>
                      )),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {googleUsers.map((u) => {
                    const granted = matrix.get(u.id) ?? new Set<GoogleScope>();
                    return (
                      <tr
                        key={u.id}
                        className="border-b border-gray-100 last:border-0"
                      >
                        <td className="py-2 pr-3">
                          <div className="font-medium text-gray-900">
                            {u.displayName ?? u.userName}
                          </div>
                          <div className="text-[10px] text-gray-400">
                            {u.userName}
                          </div>
                        </td>
                        {SCOPE_GROUPS.flatMap((grp) =>
                          grp.scopes.map(({ scope }) => {
                            const key = `${u.id}:${scope}`;
                            const checked = granted.has(scope);
                            const busy = busyCell === key;
                            return (
                              <td
                                key={scope}
                                className="px-2 py-2 text-center"
                              >
                                <label
                                  className={`inline-flex cursor-pointer items-center justify-center ${
                                    busy ? "opacity-50" : ""
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={busy}
                                    onChange={() => toggle(u.id, scope)}
                                    className="h-4 w-4 cursor-pointer accent-indigo-500"
                                  />
                                </label>
                              </td>
                            );
                          }),
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-3 text-[10px] text-gray-400">
                Grants apply only to the selected agent. System / executor agents
                inherit permissions from their caller — they do not own grants.
                {ALL_GOOGLE_SCOPES.length} scopes total.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
