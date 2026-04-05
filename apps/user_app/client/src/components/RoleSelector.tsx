import { useState, useEffect, useRef } from "react";
import { ChevronDown, Check, Shield } from "lucide-react";

export interface RoleOption {
  id: string;
  name: string;
}

interface RoleSelectorProps {
  roles: RoleOption[];
  currentRoleId: string;
  onRoleChanged: (roleId: string) => void;
  /** If true, show a compact inline style (for forms). Matches the other `*Selector`s. */
  compact?: boolean;
  /** Label shown when no role is picked. */
  placeholder?: string;
  /** Text shown for the "no role" entry inside the menu (default: "Default (user)"). */
  emptyOptionLabel?: string;
}

/**
 * Role dropdown — visual twin of `ModelSelector` / `VendorSelector`, just
 * scoped to the admin `roles` table. Includes a first "no role" option so the
 * user can leave the selection empty (falling back to the default role on the server).
 */
export default function RoleSelector({
  roles,
  currentRoleId,
  onRoleChanged,
  compact,
  placeholder = "Default (user)",
  emptyOptionLabel = "Default (user)",
}: RoleSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const current = roles.find((r) => r.id === currentRoleId) ?? null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={
          compact
            ? `flex w-full items-center gap-2 rounded-xl border border-gray-200 bg-gray-50/80 px-3 py-2 text-xs transition-all duration-200 hover:border-indigo-300 hover:bg-white focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-500/10`
            : `inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-3 py-1.5 text-[11px] font-semibold text-gray-600 shadow-sm transition-all duration-200 hover:shadow-md active:scale-95`
        }
        title="Change role"
      >
        <Shield className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
        <span
          className={
            compact
              ? "flex-1 text-left truncate"
              : "max-w-[7rem] truncate sm:max-w-none"
          }
        >
          {current?.name ?? placeholder}
        </span>
        <ChevronDown
          className={`h-3 w-3 flex-shrink-0 opacity-50 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-[calc(100vw-2rem)] sm:w-72 max-w-72 animate-scale-in rounded-2xl border border-gray-200/80 bg-white/95 shadow-glass-lg backdrop-blur-xl">
          <div className="p-1.5 max-h-64 overflow-y-auto">
            {/* "No role / default" option */}
            <button
              type="button"
              onClick={() => {
                onRoleChanged("");
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs transition-all duration-150 ${
                !currentRoleId
                  ? "bg-indigo-50 ring-1 ring-indigo-100"
                  : "hover:bg-gray-50"
              }`}
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-gray-400 text-[10px] font-bold">
                —
              </span>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-900">{emptyOptionLabel}</p>
                <p className="text-[10px] text-gray-400">No role assigned</p>
              </div>
              {!currentRoleId && <Check className="h-4 w-4 text-indigo-600" />}
            </button>

            {roles.length === 0 && (
              <p className="px-3 py-2.5 text-[11px] text-gray-400">
                No roles configured.
              </p>
            )}
            {roles.map((r) => {
              const isSelected = r.id === currentRoleId;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    onRoleChanged(r.id);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs transition-all duration-150 ${
                    isSelected
                      ? "bg-indigo-50 ring-1 ring-indigo-100"
                      : "hover:bg-gray-50"
                  }`}
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-indigo-200/80 bg-indigo-50 text-indigo-600">
                    <Shield className="h-3.5 w-3.5" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 capitalize">
                      {r.name.replace(/_/g, " ")}
                    </p>
                    <p className="font-mono text-[10px] text-gray-400 truncate">
                      {r.name}
                    </p>
                  </div>
                  {isSelected && <Check className="h-4 w-4 text-indigo-600" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
