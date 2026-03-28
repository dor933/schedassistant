import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

interface ToastItem {
  id: number;
  message: string;
  type: "success" | "error" | "info";
}

interface ToastContextValue {
  toast: (message: string, type?: ToastItem["type"]) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, type: ToastItem["type"] = "info") => {
    const id = ++nextId;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* Toast container */}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`flex items-center gap-2.5 rounded-xl px-4 py-3 text-sm shadow-lg backdrop-blur-xl animate-slide-up ${
              t.type === "success"
                ? "bg-emerald-50/95 text-emerald-700 ring-1 ring-emerald-200/60"
                : t.type === "error"
                  ? "bg-red-50/95 text-red-700 ring-1 ring-red-200/60"
                  : "bg-white/95 text-gray-700 ring-1 ring-gray-200/60"
            }`}
          >
            {t.type === "success" ? (
              <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-500" />
            ) : t.type === "error" ? (
              <AlertCircle className="h-4 w-4 flex-shrink-0 text-red-500" />
            ) : (
              <Info className="h-4 w-4 flex-shrink-0 text-indigo-500" />
            )}
            <span className="flex-1 text-[13px] leading-snug">{t.message}</span>
            <button
              onClick={() => dismiss(t.id)}
              className="flex-shrink-0 rounded-lg p-0.5 opacity-60 transition hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
