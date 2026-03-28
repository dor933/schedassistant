import { useState, useEffect, useRef } from "react";
import { ChevronDown, Check, AlertTriangle, Loader2 } from "lucide-react";
import type { ConversationModelInfo } from "../api";
import { admin } from "../api";
import { VendorIcon, vendorColors } from "./VendorModelBadge";

interface ModelSelectorProps {
  currentModel: ConversationModelInfo | null;
  conversationType: "group" | "single";
  conversationId: string;
  onModelChanged: (model: ConversationModelInfo) => void;
}

export default function ModelSelector({
  currentModel,
  conversationType,
  conversationId,
  onModelChanged,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ConversationModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

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
        setError(null);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  async function selectModel(model: ConversationModelInfo) {
    setError(null);
    setSwitching(model.id);
    try {
      if (conversationType === "single") {
        await admin.setSingleChatModel(conversationId, model.id);
      } else {
        await admin.setGroupModel(conversationId, model.id);
      }
      onModelChanged(model);
      setOpen(false);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to switch model";
      setError(msg);
    } finally {
      setSwitching(null);
    }
  }

  const vendorSlug = currentModel?.vendor?.slug ?? "unknown";
  const colors =
    vendorColors[vendorSlug] ??
    "bg-gray-50 text-gray-600 border-gray-200";

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={() => {
          setOpen(!open);
          setError(null);
        }}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-semibold shadow-sm transition-all duration-200 hover:shadow-md active:scale-95 ${colors}`}
        title="Change model"
      >
        <VendorIcon slug={vendorSlug} />
        <span className="max-w-[7rem] truncate sm:max-w-none">{currentModel?.name ?? "Select model"}</span>
        <ChevronDown
          className={`h-3 w-3 flex-shrink-0 opacity-50 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[calc(100vw-2rem)] sm:w-72 max-w-72 animate-scale-in rounded-2xl border border-gray-200/80 bg-white/95 shadow-glass-lg backdrop-blur-xl">
          {error && (
            <div className="flex items-start gap-2 border-b border-red-100 bg-red-50 px-3 py-2.5 rounded-t-2xl">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" />
              <p className="text-[11px] leading-tight text-red-700">{error}</p>
            </div>
          )}

          <div className="p-1.5 max-h-64 overflow-y-auto">
            {loading && (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
              </div>
            )}
            {!loading &&
              models.map((m) => {
                const isSelected = m.id === currentModel?.id;
                const isSwitching = switching === m.id;
                const mVendor = m.vendor?.slug ?? "unknown";
                const mColors = vendorColors[mVendor] ?? "";
                return (
                  <button
                    key={m.id}
                    onClick={() => selectModel(m)}
                    disabled={isSwitching || isSelected}
                    className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs transition-all duration-150 ${
                      isSelected
                        ? "bg-indigo-50 ring-1 ring-indigo-100"
                        : "hover:bg-gray-50"
                    } disabled:opacity-60`}
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
                    {isSwitching ? (
                      <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
                    ) : isSelected ? (
                      <Check className="h-4 w-4 text-indigo-600" />
                    ) : null}
                  </button>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}
