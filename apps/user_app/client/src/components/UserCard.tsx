import { useState } from "react";
import { AdminUser } from "../api";
import { AdminRole } from "../api";
import { Box } from "@mui/material";
import { Loader2 } from "lucide-react";
import { Save } from "lucide-react";
import { X } from "lucide-react";
import { Pencil } from "lucide-react";
import { admin } from "../api";
import { formatUserIdentityPreview } from "../pages/AdminPage";

export default function UserCard({
    u,
    roles: availableRoles,
    currentUserRole,
    onSaved,
  }: {
    u: AdminUser;
    roles: AdminRole[];
    currentUserRole: string;
    onSaved: () => void;
  }) {
    const isSuperAdmin = currentUserRole === "super_admin";
    const targetIsSuperAdmin = u.role === "super_admin";
    const targetIsAdminOrAbove = u.role === "admin" || u.role === "super_admin";
    // Admins cannot edit super_admin users; super_admins can edit anyone
    const canEdit = isSuperAdmin || !targetIsSuperAdmin;
    // Admins can only see/change identity for regular users (not admin/super_admin)
    const canEditIdentity = isSuperAdmin || !targetIsAdminOrAbove;
    const [editing, setEditing] = useState(false);
    const [displayName, setDisplayName] = useState(u.displayName ?? "");
    const [selectedRoleId, setSelectedRoleId] = useState(u.roleId ?? "");
    const [role, setRole] = useState((u.userIdentity as any)?.role ?? "");
    const [department, setDepartment] = useState(
      (u.userIdentity as any)?.department ?? "",
    );
    const [locationAndTimezone, setLocationAndTimezone] = useState(() => {
      const id = u.userIdentity as Record<string, unknown> | null | undefined;
      const loc = id?.location;
      const tz = id?.timezone;
      if (typeof loc === "string" && loc) {
        if (typeof tz === "string" && tz && !loc.includes(tz)) {
          return `${loc} (${tz})`;
        }
        return loc;
      }
      if (typeof tz === "string" && tz) return tz;
      return "";
    });
    const [saving, setSaving] = useState(false);
  
    async function save() {
      setSaving(true);
      try {
        const identity: Record<string, string> = {};
        if (role) identity.role = role;
        if (department) identity.department = department;
        if (locationAndTimezone.trim()) identity.location = locationAndTimezone.trim();
  
        await admin.updateUser(u.id, {
          displayName: displayName || undefined,
          userIdentity:
            Object.keys(identity).length > 0 ? identity : undefined,
          roleId: selectedRoleId || undefined,
        });
        setEditing(false);
        onSaved();
      } catch {
        /* ignore */
      } finally {
        setSaving(false);
      }
    }
  
    const inputClass =
      "w-full rounded-xl border border-gray-200 bg-gray-50/80 px-3 py-2 text-xs transition-all duration-200 focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-500/10";
  
    return (
      <Box className="rounded-xl border border-gray-200/60 bg-white p-4 shadow-glass transition-all duration-200 hover:shadow-md min-w-0">
        {editing ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 min-[380px]:grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-[10px] font-medium text-gray-500">
                  Display Name
                </label>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className={inputClass}
                />
              </div>
              {isSuperAdmin && (
                <div>
                  <label className="mb-1 block text-[10px] font-medium text-gray-500">
                    Access Level
                  </label>
                  <select
                    value={selectedRoleId}
                    onChange={(e) => setSelectedRoleId(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">No role</option>
                    {availableRoles.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            {canEditIdentity && (
            <div className="grid grid-cols-1 min-[380px]:grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-[10px] font-medium text-gray-500">
                  Role
                </label>
                <input
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-medium text-gray-500">
                  Department
                </label>
                <input
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div className="col-span-2">
                <label className="mb-1 block text-[10px] font-medium text-gray-500">
                  Location &amp; timezone
                </label>
                <input
                  value={locationAndTimezone}
                  onChange={(e) => setLocationAndTimezone(e.target.value)}
                  placeholder="e.g. Israel (Asia/Jerusalem)"
                  className={inputClass}
                />
              </div>
            </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={save}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all duration-200 hover:shadow-md disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Save className="h-3 w-3" />
                )}
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-200"
              >
                <X className="h-3 w-3" />
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-gray-100 to-gray-200 text-xs font-bold text-gray-600">
                  {(u.displayName || "U").charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900">
                    {u.displayName || "\u2014"}
                  </p>
                  <p className="break-all font-mono text-[10px] text-gray-400">{u.id}</p>
                </div>
                {u.role === "super_admin" && (
                  <span className="ml-1 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-600">
                    super admin
                  </span>
                )}
                {u.role === "admin" && (
                  <span className="ml-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-600">
                    admin
                  </span>
                )}
              </div>
              {canEditIdentity && u.userIdentity &&
                Object.keys(u.userIdentity as object).length > 0 && (
                  <pre className="mt-2 max-h-40 min-w-0 max-w-full overflow-auto rounded-lg border border-gray-100 bg-gray-50/90 p-2.5 text-left text-[10px] leading-relaxed break-words whitespace-pre-wrap font-mono text-gray-700">
                    {formatUserIdentityPreview(
                      u.userIdentity as Record<string, unknown>,
                    )}
                  </pre>
                )}
            </div>
            {canEdit && (
              <button
                onClick={() => setEditing(true)}
                className="flex-shrink-0 rounded-xl bg-gray-100 p-2 text-gray-500 transition hover:bg-gray-200 hover:text-gray-700"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
      </Box>
    );
  }