import { useState, useEffect, useRef, useCallback } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Container from "@mui/material/Container";
import {
  Menu,
  Sparkles,
  X,
  Loader2,
  AlertTriangle,
  ChevronUp,
  ChevronDown,
  Bot,
  Search,
} from "lucide-react";
import VendorModelBadge from "../components/VendorModelBadge";
import { useAuth } from "../context/AuthContext";
import {
  getSessions,
  createSession,
  sendMessage,
  getUnreadCounts,
  getConversationHistory,
  searchConversationHistory,
  deleteSingleChat,
  type Session,
  type SearchResult,
} from "../api";
import {
  getChatSocket,
  markConversationSeen,
  emitSyncActiveTyping,
  type ChatReplyPayload,
} from "../sockets/chatSocket";
import { useToast } from "../components/Toast";
import SessionSidebar, {
  type ConversationRef,
} from "../components/SessionSidebar";
import ChatMessage from "../components/ChatMessage";
import ChatInput from "../components/ChatInput";

const PAGE_SIZE = 20;

interface Message {
  role: "user" | "assistant";
  content: string;
  senderName?: string;
  vendorSlug?: string;
  modelName?: string;
  createdAt?: string;
  _absIndex?: number;
}

// --- NEW HELPER: Safely extracts thoughts and texts from JSON strings ---
function parseContent(content: string): { thinking: string | null; text: string } {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      let thinking = "";
      let text = "";
      parsed.forEach((block: any) => {
        if (block.type === "thinking" && block.thinking) {
          thinking += block.thinking + "\n";
        } else if (block.type === "text" && block.text) {
          text += block.text;
        }
      });
      // Ensure we actually got valid parsed blocks before returning
      if (thinking || text) {
        return { thinking: thinking.trim(), text: text.trim() || content };
      }
    }
  } catch {
    // Fails silently if the content is just a normal string
  }
  return { thinking: null, text: content };
}

export default function ChatPage() {
  const { user, conversations, setConversations, logout } = useAuth();
  const { toast } = useToast();

  const [activeConv, setActiveConv] = useState<ConversationRef | null>(null);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sendingConvId, setSendingConvId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [typingConversations, setTypingConversations] = useState<Set<string>>(
    new Set(),
  );
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const pendingReplies = useRef(
    new Map<string, (p: ChatReplyPayload) => void>(),
  );
  const activeConvRef = useRef<ConversationRef | null>(null);
  activeConvRef.current = activeConv;

  // Pagination state
  const [totalMessages, setTotalMessages] = useState(0);
  const [loadedFrom, setLoadedFrom] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const hasMoreMessages = loadedFrom > 0;

  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchIdx, setSearchIdx] = useState(-1);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    getUnreadCounts()
      .then(setUnreadCounts)
      .catch(() => { });
  }, []);

  const [loadingHistory, setLoadingHistory] = useState(false);

  const sanitize = useCallback(
    (s: string) =>
      s.replace(/[\s<|\\/>]+/g, "_").replace(/^_+|_+$/g, "") || "user",
    [],
  );
  const myName = sanitize(
    String(user?.displayName ?? user?.id ?? ""),
  );

  const toMessage = useCallback(
    (
      h: {
        role: string;
        content: string;
        senderName?: string;
        vendorSlug?: string;
        modelName?: string;
        createdAt?: string;
      },
      absIndex?: number,
    ): Message => ({
      role: h.role as Message["role"],
      content: h.content,
      senderName:
        h.senderName && sanitize(h.senderName) !== myName
          ? h.senderName.replace(/_/g, " ")
          : undefined,
      vendorSlug: h.vendorSlug,
      modelName: h.modelName,
      createdAt: h.createdAt,
      _absIndex: absIndex,
    }),
    [sanitize, myName],
  );

  useEffect(() => {
    if (!activeConv) {
      setActiveSession(null);
      setMessages([]);
      setTotalMessages(0);
      setLoadedFrom(0);
      return;
    }

    let cancelled = false;
    const scope = { singleChatId: activeConv.id };

    setMessages([]);
    setTotalMessages(0);
    setLoadedFrom(0);
    setLoadingHistory(true);
    setSearchOpen(false);
    setSearchQuery("");
    setSearchResults([]);
    setSearchIdx(-1);

    getSessions(scope)
      .then(async (list) => {
        if (cancelled) return;
        let session: Session | null = null;
        if (list.length > 0) {
          session = list[0];
        } else {
          await createSession(scope);
          const after = await getSessions(scope);
          session = after[0] ?? null;
        }
        if (cancelled) return;
        setActiveSession(session);

        try {
          const { messages: history, total } = await getConversationHistory(
            activeConv.id,
            "single",
            { limit: PAGE_SIZE },
          );
          if (!cancelled) {
            setTotalMessages(total);
            const offset = Math.max(0, total - history.length);
            setLoadedFrom(offset);
            if (history.length > 0) {
              setMessages(history.map((h, i) => toMessage(h, offset + i)));
            }
          }
        } catch {
          // No history available
        }
      })
      .catch(() => { })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });

    markConversationSeen(activeConv.id, activeConv.type);
    setUnreadCounts((prev) => {
      if (!prev[activeConv.id]) return prev;
      const next = { ...prev };
      delete next[activeConv.id];
      return next;
    });

    return () => {
      cancelled = true;
    };
  }, [activeConv?.id]);

  const prevMsgCount = useRef(0);
  useEffect(() => {
    if (messages.length > 0 && messages.length >= prevMsgCount.current) {
      if (!loadingMore) {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }
    }
    prevMsgCount.current = messages.length;
  }, [messages, loadingMore]);

  const handleLoadMore = useCallback(async () => {
    if (!activeConv || loadingMore || loadedFrom <= 0) return;
    setLoadingMore(true);

    const container = scrollContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;

    try {
      const offset = Math.max(0, loadedFrom - PAGE_SIZE);
      const limit = loadedFrom - offset;
      const { messages: older } = await getConversationHistory(
        activeConv.id,
        "single",
        { limit, offset },
      );

      if (older.length > 0) {
        const olderMessages = older.map((h, i) => toMessage(h, offset + i));
        setMessages((prev) => [...olderMessages, ...prev]);
        setLoadedFrom(offset);

        requestAnimationFrame(() => {
          if (container) {
            const newScrollHeight = container.scrollHeight;
            container.scrollTop = newScrollHeight - prevScrollHeight;
          }
        });
      }
    } catch {
      // Ignore
    } finally {
      setLoadingMore(false);
    }
  }, [activeConv, loadingMore, loadedFrom, toMessage]);

  useEffect(() => {
    const sentinel = topSentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMoreMessages && !loadingMore) {
          handleLoadMore();
        }
      },
      { root: scrollContainerRef.current, threshold: 0.1 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMoreMessages, loadingMore, handleLoadMore]);

  // Search handlers
  const navigateRef = useRef<typeof navigateToResult>(() => Promise.resolve());
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();

  const handleSearch = useCallback(
    async (query: string) => {
      setSearchQuery(query);
      if (!query.trim() || !activeConv) {
        setSearchResults([]);
        setSearchIdx(-1);
        return;
      }
      setSearching(true);
      try {
        const { results } = await searchConversationHistory(
          activeConv.id,
          "single",
          query.trim(),
        );
        setSearchResults(results);
        const idx = results.length > 0 ? results.length - 1 : -1;
        setSearchIdx(idx);
        if (idx >= 0) navigateRef.current(results[idx]);
      } catch {
        setSearchResults([]);
        setSearchIdx(-1);
      } finally {
        setSearching(false);
      }
    },
    [activeConv],
  );

  const navigateToResult = useCallback(
    async (result: SearchResult) => {
      if (!activeConv) return;

      const isLoaded =
        result.index >= loadedFrom &&
        result.index < loadedFrom + messages.length;

      if (!isLoaded) {
        const targetOffset = Math.max(
          0,
          result.index - Math.floor(PAGE_SIZE / 2),
        );
        setLoadingMore(true);
        try {
          const { messages: page, total } = await getConversationHistory(
            activeConv.id,
            "single",
            {
              limit: Math.max(
                PAGE_SIZE,
                loadedFrom + messages.length - targetOffset,
              ),
              offset: targetOffset,
            },
          );
          setTotalMessages(total);
          setLoadedFrom(targetOffset);
          setMessages(page.map((h, i) => toMessage(h, targetOffset + i)));
        } catch {
          // ignore
        } finally {
          setLoadingMore(false);
        }
      }

      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-msg-index="${result.index}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("search-highlight-flash");
          setTimeout(() => el.classList.remove("search-highlight-flash"), 1500);
        }
      });
    },
    [activeConv, loadedFrom, messages.length, toMessage],
  );
  navigateRef.current = navigateToResult;

  const handleSearchNav = useCallback(
    (direction: "prev" | "next") => {
      if (searchResults.length === 0) return;
      let next: number;
      if (direction === "next") {
        next = searchIdx < searchResults.length - 1 ? searchIdx + 1 : 0;
      } else {
        next = searchIdx > 0 ? searchIdx - 1 : searchResults.length - 1;
      }
      setSearchIdx(next);
      navigateToResult(searchResults[next]);
    },
    [searchResults, searchIdx, navigateToResult],
  );

  useEffect(() => {
    if (!user) return;
    const token = localStorage.getItem("token");
    if (!token) return;

    const socket = getChatSocket(token);

    const onTyping = (data: {
      conversationId: string;
      conversationType: string;
    }) => {
      setTypingConversations((prev) => {
        const next = new Set(prev);
        next.add(data.conversationId);
        return next;
      });
    };

    const onReply = (p: ChatReplyPayload) => {
      setTypingConversations((prev) => {
        if (!prev.has(p.conversationId)) return prev;
        const next = new Set(prev);
        next.delete(p.conversationId);
        return next;
      });

      const cb = pendingReplies.current.get(p.requestId);
      if (cb) {
        cb(p);
        pendingReplies.current.delete(p.requestId);
      }

      const current = activeConvRef.current;
      const isForActiveConv = current && current.id === p.conversationId;

      if (isForActiveConv) {
        if (!cb && p.ok) {
          setTotalMessages((t) => t + 1);
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: p.reply,
              vendorSlug: p.vendorSlug,
              modelName: p.modelName,
            },
          ]);
        }
        markConversationSeen(p.conversationId, p.conversationType);
      } else {
        setUnreadCounts((prev) => ({
          ...prev,
          [p.conversationId]: (prev[p.conversationId] ?? 0) + 1,
        }));
      }
    };

    const onAdminChange = (data: {
      type: string;
      message: string;
      data: any;
      actorId?: number;
    }) => {
      if (data.actorId === user?.id) return;

      toast(data.message, "info");
    };

    const onConversationsUpdated = (data: any) => {
      if (data.action === "single_chat_added" && data.singleChat) {
        setConversations((prev) => {
          if (!prev) return prev;
          if (prev.singleChats.some((sc) => sc.id === data.singleChat.id)) return prev;
          return {
            ...prev,
            singleChats: [...prev.singleChats, data.singleChat],
          };
        });
      } else if (data.action === "agent_model_changed" && data.agentId) {
        const newModel = data.model ?? null;
        // Update model on all conversations that use this agent
        setConversations((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            singleChats: prev.singleChats.map((sc) =>
              sc.agentId === data.agentId ? { ...sc, model: newModel } : sc,
            ),
          };
        });
        // Update the active conversation if it uses this agent
        setActiveConv((prev) =>
          prev && prev.agentId === data.agentId
            ? { ...prev, model: newModel }
            : prev,
        );
      }
    };

    socket.on("thread:typing", onTyping);
    socket.on("chat:reply", onReply);
    socket.on("conversations:updated", onConversationsUpdated);
    socket.on("admin:change", onAdminChange);
    // Restore sidebar "typing..." after navigating back from Admin (same socket, no reconnect).
    emitSyncActiveTyping();
    return () => {
      socket.off("thread:typing", onTyping);
      socket.off("chat:reply", onReply);
      socket.off("conversations:updated", onConversationsUpdated);
      socket.off("admin:change", onAdminChange);
    };
  }, [user]);

  const handleSelectConversation = useCallback((conv: ConversationRef) => {
    setActiveConv(conv);
    setSidebarOpen(false);
  }, []);

  // Delete Chat confirmation
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteSingleChat(deleteTarget.id);
      // Conversation cleared — just wipe the messages for the active view.
      // The SingleChat row persists (agent↔user pair is permanent).
      if (activeConv?.id === deleteTarget.id) {
        setMessages([]);
        setTotalMessages(0);
        setLoadedFrom(0);
      }
      setDeleteTarget(null);
    } catch (err: any) {
      alert(err.message || "Failed to clear conversation");
    } finally {
      setDeleting(false);
    }
  }

  const handleSend = useCallback(
    async (text: string) => {
      if (!activeConv) return;

      if (!activeSession) {
        try {
          const scope = { singleChatId: activeConv.id };
          await createSession({
            title: text.slice(0, 60),
            ...scope,
          });
          const list = await getSessions(scope);
          setActiveSession(list[0] ?? null);
        } catch {
          return;
        }
      }

      await doSend(text);
    },
    [activeConv, activeSession],
  );

  async function doSend(text: string) {
    const userMsg: Message = {
      role: "user",
      content: text,
      _absIndex: totalMessages,
    };
    setTotalMessages((t) => t + 1);
    setMessages((prev) => [...prev, userMsg]);
    setSendingConvId(activeConv?.id ?? null);

    const requestId = crypto.randomUUID();

    const scope = activeConv
      ? {
        singleChatId: activeConv.id,
        ...(activeConv.agentId ? { agentId: activeConv.agentId } : {}),
      }
      : undefined;

    const replyPromise = new Promise<ChatReplyPayload>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingReplies.current.delete(requestId);
        reject(new Error("Timed out waiting for assistant reply."));
      }, 240_000);

      pendingReplies.current.set(requestId, (p) => {
        window.clearTimeout(timeout);
        resolve(p);
      });
    });

    try {
      await sendMessage(text, requestId, scope);
      const p = await replyPromise;
      // Only append the reply if the user is still viewing the same conversation.
      // If they switched away, the reply is already persisted in conversation_messages
      // and will load when they navigate back.
      if (activeConvRef.current?.id !== activeConv?.id) return;
      setTotalMessages((t) => t + 1);
      if (p.ok) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: p.reply,
            vendorSlug: p.vendorSlug,
            modelName: p.modelName,
            _absIndex:
              prev.length > 0
                ? (prev[prev.length - 1]._absIndex ?? prev.length - 1) + 1
                : 0,
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${p.error}` },
        ]);
      }
    } catch (err: unknown) {
      pendingReplies.current.delete(requestId);
      const errorText =
        err instanceof Error ? err.message : "Something went wrong";
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${errorText}` },
      ]);
    } finally {
      setSendingConvId(null);
    }
  }

  const convName = activeConv?.name || "Select a conversation";
  const sending = activeConv ? sendingConvId === activeConv.id : false;
  const agentIsTyping = activeConv
    ? typingConversations.has(activeConv.id)
    : false;

  const handleUserTyping = useCallback(() => {
    // no-op: single chats don't emit user typing
  }, []);

  return (
    <Stack
      direction="row"
      sx={{
        height: "100dvh",
        bgcolor: "rgb(249 250 251 / 0.5)",
        overflow: "hidden",
      }}
    >
      {/* Mobile sidebar toggle — hidden when sidebar is open */}
      {!sidebarOpen && (
        <Box
          component="button"
          onClick={() => {
            setSidebarOpen(true);
          }}
          className="rounded-xl border border-gray-200/80 bg-white/90 shadow-glass backdrop-blur-sm transition-all duration-200 hover:shadow-md active:scale-95"
          sx={{
            position: "fixed",
            left: 12,
            top: 12,
            zIndex: 30,
            p: 1.25,
            display: { xs: "block", sm: "none" },
          }}
        >
          <Menu className="h-5 w-5 text-gray-600" />
        </Box>
      )}

      {/* Sidebar */}
      <Box
        sx={{
          position: { xs: "fixed", sm: "relative" },
          inset: { xs: "0 auto 0 0" },
          zIndex: 20,
          transform: {
            xs: sidebarOpen ? "translateX(0)" : "translateX(-100%)",
            sm: "translateX(0)",
          },
          transition: "transform 300ms ease-out",
        }}
      >
        <SessionSidebar
          singleChats={conversations?.singleChats ?? []}
          activeConversationId={activeConv?.id ?? null}
          setActiveConversation={setActiveConv}
          unreadCounts={unreadCounts}
          typingConversations={typingConversations}
          isAdmin={user?.role === "admin" || user?.role === "super_admin"}
          onSelectConversation={handleSelectConversation}
          onDeleteChat={(id, title) => setDeleteTarget({ id, title })}
          onLogout={logout}
          userName={
            user?.displayName ??
            (user?.id != null ? String(user.id) : null)
          }
        />
      </Box>

      {/* Overlay on mobile */}
      {sidebarOpen && (
        <Box
          className="animate-fade-in"
          onClick={() => setSidebarOpen(false)}
          sx={{
            position: "fixed",
            inset: 0,
            zIndex: 10,
            bgcolor: "rgba(0,0,0,0.2)",
            backdropFilter: "blur(4px)",
            display: { xs: "block", sm: "none" },
          }}
        />
      )}

      {/* Main Chat Area */}
      <Stack component="main" sx={{ flex: 1, minWidth: 0, bgcolor: "white" }}>
        {/* Chat Header */}
        <Stack
          component="header"
          direction="row"
          alignItems="center"
          className="border-b border-gray-100 bg-white/80 backdrop-blur-xl"
          sx={{
            px: { xs: 2, sm: 3 },
            py: 1.75,
            gap: { xs: 1, sm: 1.5 },
          }}
        >
          <Box
            sx={{
              ml: { xs: 7, sm: 0 },
              minWidth: 0,
              flex: 1,
            }}
          >
            <Box
              component="h2"
              className="font-semibold text-gray-900 tracking-tight"
              sx={{
                fontSize: { xs: "13px", sm: "14px" },
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {convName}
            </Box>
            {agentIsTyping ? (
              <Stack
                direction="row"
                alignItems="center"
                spacing={0.75}
                className="text-xs font-medium text-emerald-600"
              >
                <Box
                  component="span"
                  sx={{
                    position: "relative",
                    display: "flex",
                    width: 8,
                    height: 8,
                  }}
                >
                  <Box
                    component="span"
                    className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"
                  />
                  <Box
                    component="span"
                    className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"
                  />
                </Box>
                <span>Agent is typing...</span>
              </Stack>
            ) : (
              <Box component="p" className="text-xs text-gray-400">
                {activeConv?.type === "single" ? "Direct Chat" : "Default Chat"}
              </Box>
            )}
          </Box>

          <Stack
            direction="row"
            alignItems="center"
            sx={{ flexShrink: 0, gap: 1 }}
          >
            {activeConv?.model ? (
              <VendorModelBadge model={activeConv.model} />
            ) : null}
            {activeConv && (
              <Box
                component="button"
                onClick={() => {
                  setSearchOpen((v) => !v);
                  if (searchOpen) {
                    setSearchQuery("");
                    setSearchResults([]);
                    setSearchIdx(-1);
                  }
                }}
                className={`flex-shrink-0 rounded-xl p-2 transition-all duration-200 ${searchOpen
                  ? "bg-indigo-50 text-indigo-600 ring-1 ring-indigo-200/60"
                  : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                  }`}
                title="Search in chat"
              >
                <Search className="h-4 w-4" />
              </Box>
            )}
          </Stack>
        </Stack>

        {/* Search Bar */}
        {searchOpen && activeConv && (
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="center"
            className="border-b border-gray-100 bg-gray-50/80 animate-slide-up"
            sx={{ px: { xs: 2, sm: 3 }, py: 1 }}
          >
            <Stack
              direction="row"
              alignItems="center"
              spacing={1}
              className="rounded-full bg-white ring-1 ring-gray-200/80 shadow-sm"
              sx={{ width: "100%", maxWidth: "36rem", px: 2, py: 0.75 }}
            >
              <Search className="h-4 w-4 flex-shrink-0 text-gray-400" />
              <Box
                component="input"
                autoFocus
                type="text"
                value={searchQuery}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const val = e.target.value;
                  setSearchQuery(val);
                  clearTimeout(searchTimer.current);
                  if (!val.trim()) {
                    setSearchResults([]);
                    setSearchIdx(-1);
                    return;
                  }
                  searchTimer.current = setTimeout(
                    () => handleSearch(val),
                    300,
                  );
                }}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === "Escape") {
                    setSearchOpen(false);
                    setSearchQuery("");
                    setSearchResults([]);
                    setSearchIdx(-1);
                  } else if (e.key === "Enter") {
                    handleSearchNav(e.shiftKey ? "prev" : "next");
                  }
                }}
                placeholder="Search messages..."
                className="bg-transparent text-sm text-gray-900 placeholder-gray-400 outline-none"
                sx={{ flex: 1, minWidth: 0 }}
              />
              {searching && (
                <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
              )}
              {searchResults.length > 0 && (
                <Stack direction="row" alignItems="center" spacing={0.5}>
                  <Box
                    component="span"
                    className="text-xs text-gray-500 tabular-nums"
                    sx={{ whiteSpace: "nowrap" }}
                  >
                    {searchIdx + 1} / {searchResults.length}
                  </Box>
                  <Box
                    component="button"
                    onClick={() => handleSearchNav("prev")}
                    className="rounded-lg p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600 transition"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </Box>
                  <Box
                    component="button"
                    onClick={() => handleSearchNav("next")}
                    className="rounded-lg p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600 transition"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Box>
                </Stack>
              )}
              {searchQuery && searchResults.length === 0 && !searching && (
                <Box
                  component="span"
                  className="text-xs text-gray-400"
                  sx={{ whiteSpace: "nowrap" }}
                >
                  No results
                </Box>
              )}
              <Box
                component="button"
                onClick={() => {
                  setSearchOpen(false);
                  setSearchQuery("");
                  setSearchResults([]);
                  setSearchIdx(-1);
                }}
                className="rounded-lg p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600 transition"
              >
                <X className="h-3.5 w-3.5" />
              </Box>
            </Stack>
          </Stack>
        )}

        {/* Messages Area */}
        <Box
          ref={scrollContainerRef}
          sx={{
            flex: 1,
            overflowY: "auto",
            px: { xs: 2, sm: 3 },
            py: 3,
          }}
        >
          {!activeConv && !sending && (
            <Stack
              alignItems="center"
              justifyContent="center"
              className="animate-fade-in"
              sx={{ height: "100%", textAlign: "center" }}
            >
              <Box className="mb-5 flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-indigo-50 to-blue-50 shadow-glass">
                <Sparkles className="h-9 w-9 text-indigo-400" />
              </Box>
              <Box
                component="h3"
                className="mb-1.5 text-lg font-bold text-gray-900 tracking-tight"
              >
                Select a conversation
              </Box>
              <Box
                component="p"
                className="text-sm text-gray-500 leading-relaxed"
                sx={{ maxWidth: "20rem" }}
              >
                Choose a direct chat from the sidebar to start messaging.
              </Box>
            </Stack>
          )}

          {activeConv && loadingHistory && (
            <Stack
              alignItems="center"
              justifyContent="center"
              className="animate-fade-in"
              sx={{ height: "100%" }}
            >
              <Loader2 className="h-8 w-8 animate-spin text-indigo-400" />
              <Box component="p" className="mt-3 text-sm text-gray-400">
                Loading conversation...
              </Box>
            </Stack>
          )}

          {activeConv &&
            messages.length === 0 &&
            !sending &&
            !loadingHistory && (
              <Stack
                alignItems="center"
                justifyContent="center"
                className="animate-fade-in"
                sx={{ height: "100%", textAlign: "center" }}
              >
                <Box className="mb-5 flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-indigo-50 to-blue-50 shadow-glass">
                  <Sparkles className="h-9 w-9 text-indigo-400" />
                </Box>
                <Box
                  component="h3"
                  className="mb-1.5 text-lg font-bold text-gray-900 tracking-tight"
                >
                  {convName}
                </Box>
                <Box
                  component="p"
                  className="text-sm text-gray-500 leading-relaxed"
                  sx={{ maxWidth: "20rem" }}
                >
                  Send a message to start the conversation.
                </Box>
              </Stack>
            )}

          <Container maxWidth="md" disableGutters>
            <Stack spacing={2.5}>
              {/* Top sentinel for infinite scroll */}
              <Box ref={topSentinelRef} sx={{ height: 4 }} />

              {/* Load more indicator */}
              {loadingMore && (
                <Stack
                  justifyContent="center"
                  alignItems="center"
                  className="animate-fade-in"
                  sx={{ py: 1.5 }}
                >
                  <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
                </Stack>
              )}
              {hasMoreMessages && !loadingMore && (
                <Stack alignItems="center">
                  <Box
                    component="button"
                    onClick={handleLoadMore}
                    className="rounded-full bg-gray-100 text-[11px] font-medium text-gray-500 transition hover:bg-gray-200 hover:text-gray-700"
                    sx={{ px: 1.5, py: 0.5 }}
                  >
                    Load older messages
                  </Box>
                </Stack>
              )}

              {messages.map((msg, i) => {
                const absIdx = msg._absIndex ?? i;
                const isSearchMatch =
                  searchQuery && searchResults.some((r) => r.index === absIdx);

                // --- 1. NEW LOGIC: Extract thoughts and text safely ---
                const { thinking, text } = parseContent(msg.content);

                // --- 2. NEW LOGIC: Format thoughts nicely into Markdown if they exist ---
                // We use standard Markdown blockquotes because almost all Markdown React parsers support them.
                const formattedContent = thinking
                  ? `> **💭 Agent Thoughts:**\n> \n> ${thinking.replace(/\n/g, '\n> ')}\n\n---\n\n${text}`
                  : text;

                return (
                  <Box
                    key={absIdx}
                    data-msg-index={absIdx}
                    // --- 3. NEW LOGIC: dir="auto" handles native Hebrew RTL logic while keeping English LTR ---
                    className={
                      isSearchMatch
                        ? "search-match-highlight rounded-2xl transition-colors duration-300"
                        : ""
                    }
                    sx={{ textAlign: 'start' }} // Ensures standard flex/text layouts respect dir="auto"
                  >
                    <ChatMessage
                      role={msg.role}
                      content={formattedContent}
                      senderName={msg.senderName}
                      vendorSlug={
                        msg.vendorSlug ?? activeConv?.model?.vendor?.slug
                      }
                      modelName={msg.modelName ?? activeConv?.model?.name}
                      highlightText={
                        searchQuery && isSearchMatch ? searchQuery : undefined
                      }
                      createdAt={msg.createdAt}
                    />
                  </Box>
                );
              })}

              {(sending || agentIsTyping) && (
                <Stack direction="row" className="animate-fade-in">
                  <Box
                    className={`mr-3 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl shadow-sm ring-1 ${activeConv?.model?.vendor?.slug === "openai"
                      ? "bg-emerald-50 text-emerald-700 ring-emerald-200/60"
                      : activeConv?.model?.vendor?.slug === "anthropic"
                        ? "bg-amber-50 text-amber-700 ring-amber-200/60"
                        : activeConv?.model?.vendor?.slug === "google"
                          ? "bg-blue-50 text-blue-700 ring-blue-200/60"
                          : "bg-gray-100 text-gray-500 ring-gray-200/60"
                      }`}
                  >
                    <Bot className="h-4 w-4" />
                  </Box>
                  <Box className="rounded-2xl rounded-tl-md bg-white px-4 py-3 shadow-glass ring-1 ring-gray-950/[0.04]">
                    <Stack direction="row" spacing={0.75}>
                      <Box className="h-2 w-2 animate-bounce rounded-full bg-gray-300 [animation-delay:-0.3s]" />
                      <Box className="h-2 w-2 animate-bounce rounded-full bg-gray-300 [animation-delay:-0.15s]" />
                      <Box className="h-2 w-2 animate-bounce rounded-full bg-gray-300" />
                    </Stack>
                  </Box>
                </Stack>
              )}

              <Box ref={bottomRef} />
            </Stack>
          </Container>
        </Box>

        {/* Input Bar */}
        <ChatInput
          onSend={handleSend}
          onTyping={handleUserTyping}
          disabled={!activeConv || sending || agentIsTyping}
        />
      </Stack>

      {/* Delete Chat Confirmation */}
      {deleteTarget && (
        <Stack
          alignItems={{ xs: "stretch", sm: "center" }}
          justifyContent={{ xs: "flex-end", sm: "center" }}
          className="animate-fade-in"
          sx={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            bgcolor: "rgba(0,0,0,0.3)",
            backdropFilter: "blur(4px)",
          }}
        >
          <Box
            className="animate-scale-in border border-gray-200/60 bg-white/95 shadow-glass-lg backdrop-blur-xl"
            sx={{
              width: "100%",
              maxWidth: "24rem",
              borderRadius: { xs: "1rem 1rem 0 0", sm: "1rem" },
              p: { xs: 2.5, sm: 3 },
              mx: { xs: 0, sm: 2 },
            }}
          >
            <Box className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-red-100">
              <AlertTriangle className="h-6 w-6 text-red-500" />
            </Box>
            <Box
              component="h3"
              className="mb-1 text-base font-bold text-gray-900"
            >
              Clear "{deleteTarget.title}"?
            </Box>
            <Box
              component="p"
              className="mb-5 text-sm text-gray-500 leading-relaxed"
            >
              This will permanently delete{" "}
              <strong className="text-gray-700">
                all conversation history
              </strong>{" "}
              for this chat. The chat will remain in your sidebar so you can
              start a fresh conversation. This action cannot be undone.
            </Box>
            <Stack direction="row" justifyContent="flex-end" spacing={1.25}>
              <Box
                component="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 transition-all duration-200 hover:bg-gray-50 active:scale-[0.98]"
              >
                Cancel
              </Box>
              <Box
                component="button"
                onClick={handleConfirmDelete}
                disabled={deleting}
                className="rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-red-700 active:scale-[0.98] disabled:opacity-50"
              >
                {deleting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Clear messages"
                )}
              </Box>
            </Stack>
          </Box>
        </Stack>
      )}
    </Stack>
  );
}