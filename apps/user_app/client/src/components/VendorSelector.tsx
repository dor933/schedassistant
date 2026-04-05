import { useState, useEffect, useRef } from "react";
import { ChevronDown, Check } from "lucide-react";
import { VendorIcon, vendorColors } from "./VendorModelBadge";

export interface VendorOption {
  id: string;
  name: string;
  slug: string;
}

interface VendorSelectorProps {
  vendors: VendorOption[];
  currentVendorId: string;
  onVendorChanged: (vendorId: string) => void;
  /** If true, show a compact inline style (for forms). Matches `ModelSelector`. */
  compact?: boolean;
  placeholder?: string;
}

/**
 * Dropdown vendor picker — visual twin of `ModelSelector`, just scoped to vendors.
 * Used in the admin "Models" create form so the vendor control matches the model
 * picker style instead of a raw native `<select>`.
 */
export default function VendorSelector({
  vendors,
  currentVendorId,
  onVendorChanged,
  compact,
  placeholder = "Select vendor...",
}: VendorSelectorProps) {
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

  const current = vendors.find((v) => v.id === currentVendorId) ?? null;
  const slug = current?.slug ?? "unknown";
  const colors =
    vendorColors[slug] ?? "bg-gray-50 text-gray-600 border-gray-200";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={
          compact
            ? `flex w-full items-center gap-2 rounded-xl border border-gray-200 bg-gray-50/80 px-3 py-2 text-xs transition-all duration-200 hover:border-indigo-300 hover:bg-white focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-500/10`
            : `inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-semibold shadow-sm transition-all duration-200 hover:shadow-md active:scale-95 ${colors}`
        }
        title="Change vendor"
      >
        <VendorIcon slug={slug} />
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
            {vendors.length === 0 && (
              <p className="px-3 py-2.5 text-[11px] text-gray-400">
                No vendors configured.
              </p>
            )}
            {vendors.map((v) => {
              const isSelected = v.id === currentVendorId;
              const vColors = vendorColors[v.slug] ?? "";
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => {
                    onVendorChanged(v.id);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs transition-all duration-150 ${
                    isSelected
                      ? "bg-indigo-50 ring-1 ring-indigo-100"
                      : "hover:bg-gray-50"
                  }`}
                >
                  <span
                    className={`flex h-7 w-7 items-center justify-center rounded-lg border ${vColors || "border-gray-200 bg-gray-50 text-gray-500"}`}
                  >
                    <VendorIcon slug={v.slug} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900">{v.name}</p>
                    <p className="font-mono text-[10px] text-gray-400">
                      {v.slug}
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
