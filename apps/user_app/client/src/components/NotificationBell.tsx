import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, Check, CheckCheck, Loader2 } from "lucide-react";
import {
  listInAppNotifications,
  markAllInAppNotificationsRead,
  markInAppNotificationRead,
  type InAppNotification,
} from "../api";
import { getChatSocket } from "../sockets/chatSocket";

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function NotificationBell() {
  const navigate = useNavigate();
  const [items, setItems] = useState<InAppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const res = await listInAppNotifications();
      setItems(res.items);
      setUnreadCount(res.unreadCount);
    } catch (err) {
      console.warn("Failed to load notifications", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) return;

    const socket = getChatSocket(token);
    const handleNew = (payload: InAppNotification) => {
      setItems((prev) => {
        if (prev.some((n) => n.id === payload.id)) return prev;
        return [payload, ...prev].slice(0, 50);
      });
      if (payload.readAt == null) {
        setUnreadCount((c) => c + 1);
      }
    };

    socket.on("notification:new", handleNew);
    return () => {
      socket.off("notification:new", handleNew);
    };
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const handleItemClick = async (n: InAppNotification) => {
    try {
      if (n.readAt == null) {
        await markInAppNotificationRead(n.id);
        setItems((prev) =>
          prev.map((x) =>
            x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x,
          ),
        );
        setUnreadCount((c) => Math.max(0, c - 1));
      }
    } catch (err) {
      console.warn("Failed to mark notification read", err);
    }
    if (n.link) {
      setOpen(false);
      navigate(n.link);
    }
  };

  const handleMarkAll = async () => {
    if (unreadCount === 0) return;
    try {
      await markAllInAppNotificationsRead();
      const now = new Date().toISOString();
      setItems((prev) =>
        prev.map((n) => (n.readAt == null ? { ...n, readAt: now } : n)),
      );
      setUnreadCount(0);
    } catch (err) {
      console.warn("Failed to mark all notifications read", err);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-indigo-200/80 backdrop-blur-sm transition-all hover:border-fuchsia-400/40 hover:bg-white/[0.08] hover:text-white"
        aria-label="Notifications"
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-gradient-to-br from-fuchsia-500 to-rose-500 px-1 text-[10px] font-bold text-white shadow-[0_0_10px_-2px_rgba(232,121,249,0.8)] ring-1 ring-slate-950">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-72 overflow-hidden rounded-2xl border border-white/10 bg-slate-950/95 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl sm:w-80">
          <div className="flex items-center justify-between gap-2 border-b border-white/5 px-4 py-3">
            <div className="flex items-center gap-2">
              <Bell className="h-3.5 w-3.5 text-indigo-300/80" />
              <span className="text-xs font-semibold uppercase tracking-wider text-indigo-200/80">
                Notifications
              </span>
              {unreadCount > 0 && (
                <span className="rounded-full bg-fuchsia-500/20 px-2 py-0.5 text-[10px] font-semibold text-fuchsia-200 ring-1 ring-fuchsia-400/30">
                  {unreadCount} new
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={handleMarkAll}
              disabled={unreadCount === 0}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-indigo-200/80 transition hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              <CheckCheck className="h-3 w-3" />
              Mark all read
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto dark-scroll">
            {loading && items.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-4 w-4 animate-spin text-indigo-300/70" />
              </div>
            ) : items.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-indigo-200/50">
                No notifications yet
              </p>
            ) : (
              <ul className="divide-y divide-white/5">
                {items.map((n) => {
                  const unread = n.readAt == null;
                  return (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => handleItemClick(n)}
                        className={`group block w-full px-4 py-3 text-left transition ${
                          unread
                            ? "bg-fuchsia-500/[0.06] hover:bg-fuchsia-500/[0.12]"
                            : "hover:bg-white/[0.04]"
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          {unread && (
                            <span className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full bg-fuchsia-400 shadow-[0_0_8px_rgba(232,121,249,0.9)]" />
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-white">
                              {n.title}
                            </p>
                            {n.body && (
                              <p className="mt-0.5 line-clamp-2 text-xs text-indigo-200/70">
                                {n.body}
                              </p>
                            )}
                            <p className="mt-1 text-[10px] text-indigo-300/50">
                              {formatRelative(n.createdAt)}
                            </p>
                          </div>
                          {!unread && (
                            <Check className="mt-1 h-3 w-3 shrink-0 text-emerald-300/60" />
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
