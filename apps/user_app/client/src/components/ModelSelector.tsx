import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronDown, Check, Loader2 } from "lucide-react";
import type { ConversationModelInfo } from "../api";
import { admin } from "../api";
import { VendorIcon, vendorColors } from "./VendorModelBadge";

interface ModelSelectorProps {
  currentModel: ConversationModelInfo | null;
  /** Called when the user picks a model — parent is responsible for persisting. */
  onModelChanged: (model: ConversationModelInfo | null) => void;
  /** If true, show a compact inline style (for forms). */
  compact?: boolean;
}

/**
 * Dropdown model picker. Used in:
 *  - Admin panel (AgentCard edit, agent creation form)
 *  - Read-only badge when `onModelChanged` is a no-op
 */
export default function ModelSelector({
  currentModel,
  onModelChanged,
  compact,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ConversationModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const updatePosition = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setDropdownStyle({
      position: "fixed",
      top: rect.bottom + 8,
      left: rect.left,
      width: Math.max(rect.width, 288), // min 18rem (w-72)
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open || models.length > 0) return;
    setLoading(true);
    admin
      .getModels()
      .then(setModels)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open]);

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

  const vendorSlug = currentModel?.vendor?.slug ?? "unknown";
  const colors =
    vendorColors[vendorSlug] ??
    "bg-gray-50 text-gray-600 border-gray-200";

  return (
    <div ref={ref} className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(!open)}
        className={
          compact
            ? `flex w-full items-center gap-2 rounded-xl border border-gray-200 bg-gray-50/80 px-3 py-2 text-xs transition-all duration-200 hover:border-indigo-300 hover:bg-white focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-500/10`
            : `inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-semibold shadow-sm transition-all duration-200 hover:shadow-md active:scale-95 ${colors}`
        }
        title="Change model"
      >
        <VendorIcon slug={vendorSlug} />
        <span className={compact ? "flex-1 text-left truncate" : "max-w-[7rem] truncate sm:max-w-none"}>
          {currentModel?.name ?? "Select model"}
        </span>
        <ChevronDown
          className={`h-3 w-3 flex-shrink-0 opacity-50 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          style={dropdownStyle}
          className="z-50 max-w-72 animate-scale-in rounded-2xl border border-gray-200/80 bg-white/95 shadow-glass-lg backdrop-blur-xl"
        >
          <div className="p-1.5 max-h-64 overflow-y-auto">
            {loading && (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
              </div>
            )}
            {/* "None / default" option */}
            {!loading && (
              <button
                onClick={() => {
                  onModelChanged(null);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs transition-all duration-150 ${
                  !currentModel
                    ? "bg-indigo-50 ring-1 ring-indigo-100"
                    : "hover:bg-gray-50"
                }`}
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-gray-400 text-[10px] font-bold">
                  —
                </span>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900">Default (gpt-4o)</p>
                  <p className="text-[10px] text-gray-400">Fallback model</p>
                </div>
                {!currentModel && <Check className="h-4 w-4 text-indigo-600" />}
              </button>
            )}
            {!loading &&
              models.map((m) => {
                const isSelected = m.id === currentModel?.id;
                const mVendor = m.vendor?.slug ?? "unknown";
                const mColors = vendorColors[mVendor] ?? "";
                return (
                  <button
                    key={m.id}
                    onClick={() => {
                      onModelChanged(m);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs transition-all duration-150 ${
                      isSelected
                        ? "bg-indigo-50 ring-1 ring-indigo-100"
                        : "hover:bg-gray-50"
                    }`}
                  >
                    <span
                      className={`flex h-7 w-7 items-center justify-center rounded-lg border ${mColors || "border-gray-200 bg-gray-50 text-gray-500"}`}
                    >
                      <VendorIcon slug={mVendor} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900">{m.name}</p>
                      <p className="text-[10px] text-gray-400">
                        {m.vendor?.name}
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
