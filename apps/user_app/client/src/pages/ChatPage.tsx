import { useState, useEffect, useRef, useCallback } from "react";
import {
  Menu,
  Sparkles,
  X,
  Loader2,
  AlertTriangle,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Users,
  Bot,
  Search,
} from "lucide-react";
import { VendorIcon } from "../components/VendorModelBadge";
import { useAuth } from "../context/AuthContext";
import {
  getSessions,
  createSession,
  sendMessage,
  getUnreadCounts,
  getHistory,
  searchHistory,
  getAgentsList,
  createSingleChat,
  deleteSingleChat,
  getGroupMembers,
  type Session,
  type AgentListItem,
  type GroupMemberInfo,
  type SearchResult,
} from "../api";
import {
  getChatSocket,
  markConversationSeen,
  emitUserTyping,
  type ChatReplyPayload,
} from "../sockets/chatSocket";
import { useToast } from "../components/Toast";
import SessionSidebar, {
  type ConversationRef,
} from "../components/SessionSidebar";
import ChatMessage from "../components/ChatMessage";
import ChatInput from "../components/ChatInput";
import VendorModelBadge from "../components/VendorModelBadge";
import ModelSelector from "../components/ModelSelector";
import type { ConversationModelInfo } from "../api";

const PAGE_SIZE = 20;

interface Message {
  role: "user" | "assistant";
  content: string;
  /** Display name of the sender — set for group messages from other users. */
  senderName?: string;
  /** Per-message model metadata (set on assistant messages). */
  vendorSlug?: string;
  modelName?: string;
  /** Absolute index in the full messages array (used for search navigation). */
  _absIndex?: number;
}

export default function ChatPage() {
  const { user, conversations, setConversations, logout } = useAuth();
  const { toast } = useToast();

  const [activeConv, setActiveConv] = useState<ConversationRef | null>(null);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [typingConversations, setTypingConversations] = useState<Set<string>>(
    new Set(),
  );
  // Tracks which users are typing in group chats: groupId → Map<userId, displayName>
  const [userTyping, setUserTyping] = useState<Map<string, Map<string, string>>>(
    new Map(),
  );
  const userTypingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
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
  const [loadedFrom, setLoadedFrom] = useState(0); // absolute index of first loaded message
  const [loadingMore, setLoadingMore] = useState(false);
  const hasMoreMessages = loadedFrom > 0;

  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchIdx, setSearchIdx] = useState(-1); // current result index
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    getUnreadCounts()
      .then(setUnreadCounts)
      .catch(() => {});
  }, []);

  const [loadingHistory, setLoadingHistory] = useState(false);
  const [groupMembersList, setGroupMembersList] = useState<GroupMemberInfo[]>([]);
  const [showGroupInfo, setShowGroupInfo] = useState(false);

  // Fetch group members when a group conversation is selected
  useEffect(() => {
    if (activeConv?.type !== "group") {
      setGroupMembersList([]);
      return;
    }
    getGroupMembers(activeConv.id)
      .then(setGroupMembersList)
      .catch(() => setGroupMembersList([]));
  }, [activeConv?.id, activeConv?.type]);

  // Helper: transform a history message into our local Message shape
  const sanitize = useCallback(
    (s: string) => s.replace(/[\s<|\\/>]+/g, "_").replace(/^_+|_+$/g, "") || "user",
    [],
  );
  const myName = sanitize(user?.displayName ?? user?.id ?? "");

  const toMessage = useCallback(
    (h: { role: string; content: string; senderName?: string; vendorSlug?: string; modelName?: string }, absIndex?: number): Message => ({
      role: h.role as Message["role"],
      content: h.content,
      senderName:
        h.senderName && sanitize(h.senderName) !== myName
          ? h.senderName.replace(/_/g, " ")
          : undefined,
      vendorSlug: h.vendorSlug,
      modelName: h.modelName,
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
    const scope =
      activeConv.type === "group"
        ? { groupId: activeConv.id }
        : { singleChatId: activeConv.id };

    setMessages([]);
    setTotalMessages(0);
    setLoadedFrom(0);
    setLoadingHistory(true);
    // Reset search when switching conversations
    setSearchOpen(false);
    setSearchQuery("");
    setSearchResults([]);
    setSearchIdx(-1);

    getSessions(scope)
      .then(async (list) => {
        if (cancelled) return;
        let session: Session;
        if (list.length > 0) {
          session = list[0];
        } else {
          session = await createSession(scope);
        }
        if (cancelled) return;
        setActiveSession(session);

        try {
          const { messages: history, total } = await getHistory(session.threadId, { limit: PAGE_SIZE });
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
      .catch(() => {})
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

  // Only auto-scroll to bottom when messages are appended (new message), not when prepended (load more).
  const prevMsgCount = useRef(0);
  useEffect(() => {
    // Scroll to bottom only on initial load or when new messages are appended at the end
    if (messages.length > 0 && messages.length >= prevMsgCount.current) {
      // Check if this is a prepend (loadMore) by seeing if loadingMore just finished
      if (!loadingMore) {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }
    }
    prevMsgCount.current = messages.length;
  }, [messages, loadingMore]);

  // Load more messages when scrolling to top
  const handleLoadMore = useCallback(async () => {
    if (!activeSession || loadingMore || loadedFrom <= 0) return;
    setLoadingMore(true);

    const container = scrollContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;

    try {
      const offset = Math.max(0, loadedFrom - PAGE_SIZE);
      const limit = loadedFrom - offset;
      const { messages: older } = await getHistory(activeSession.threadId, { limit, offset });

      if (older.length > 0) {
        const olderMessages = older.map((h, i) => toMessage(h, offset + i));
        setMessages((prev) => [...olderMessages, ...prev]);
        setLoadedFrom(offset);

        // Restore scroll position after prepending
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
  }, [activeSession, loadingMore, loadedFrom, toMessage]);

  // IntersectionObserver to detect scroll to top
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

  const handleSearch = useCallback(async (query: string) => {
    setSearchQuery(query);
    if (!query.trim() || !activeSession) {
      setSearchResults([]);
      setSearchIdx(-1);
      return;
    }
    setSearching(true);
    try {
      const { results } = await searchHistory(activeSession.threadId, query.trim());
      setSearchResults(results);
      // Start at the last (most recent) match
      const idx = results.length > 0 ? results.length - 1 : -1;
      setSearchIdx(idx);
      if (idx >= 0) navigateRef.current(results[idx]);
    } catch {
      setSearchResults([]);
      setSearchIdx(-1);
    } finally {
      setSearching(false);
    }
  }, [activeSession]);

  // Navigate to a search result, loading the page if needed
  const navigateToResult = useCallback(async (result: SearchResult) => {
    if (!activeSession) return;

    // Check if this message is already loaded
    const isLoaded = result.index >= loadedFrom && result.index < loadedFrom + messages.length;

    if (!isLoaded) {
      // Load a page centered around the target index
      const targetOffset = Math.max(0, result.index - Math.floor(PAGE_SIZE / 2));
      setLoadingMore(true);
      try {
        const { messages: page, total } = await getHistory(activeSession.threadId, {
          limit: Math.max(PAGE_SIZE, loadedFrom + messages.length - targetOffset),
          offset: targetOffset,
        });
        setTotalMessages(total);
        setLoadedFrom(targetOffset);
        setMessages(page.map((h, i) => toMessage(h, targetOffset + i)));
      } catch {
        // ignore
      } finally {
        setLoadingMore(false);
      }
    }

    // Scroll to the message after render
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-msg-index="${result.index}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("search-highlight-flash");
        setTimeout(() => el.classList.remove("search-highlight-flash"), 1500);
      }
    });
  }, [activeSession, loadedFrom, messages.length, toMessage]);
  navigateRef.current = navigateToResult;

  // Navigate between search results
  const handleSearchNav = useCallback((direction: "prev" | "next") => {
    if (searchResults.length === 0) return;
    let next: number;
    if (direction === "next") {
      next = searchIdx < searchResults.length - 1 ? searchIdx + 1 : 0;
    } else {
      next = searchIdx > 0 ? searchIdx - 1 : searchResults.length - 1;
    }
    setSearchIdx(next);
    navigateToResult(searchResults[next]);
  }, [searchResults, searchIdx, navigateToResult]);

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
        // Still mark as seen since the user is actively viewing this conversation
        markConversationSeen(p.conversationId, p.conversationType);
        return;
      }

      const current = activeConvRef.current;
      const isForActiveConv = current && current.id === p.conversationId;

      if (isForActiveConv) {
        if (p.ok) {
          setTotalMessages((t) => t + 1);
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: p.reply, vendorSlug: p.vendorSlug, modelName: p.modelName },
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

    const onUserTyping = (data: {
      groupId: string;
      userId: string;
      displayName: string;
    }) => {
      const key = `${data.groupId}:${data.userId}`;

      // Clear previous timer for this user
      const prev = userTypingTimers.current.get(key);
      if (prev) clearTimeout(prev);

      // Add typing indicator
      setUserTyping((map) => {
        const next = new Map(map);
        const groupMap = new Map(next.get(data.groupId) ?? []);
        groupMap.set(data.userId, data.displayName);
        next.set(data.groupId, groupMap);
        return next;
      });

      // Auto-clear after 3 seconds
      userTypingTimers.current.set(
        key,
        setTimeout(() => {
          userTypingTimers.current.delete(key);
          setUserTyping((map) => {
            const next = new Map(map);
            const groupMap = new Map(next.get(data.groupId) ?? []);
            groupMap.delete(data.userId);
            if (groupMap.size === 0) next.delete(data.groupId);
            else next.set(data.groupId, groupMap);
            return next;
          });
        }, 3000),
      );
    };

    const onGroupUserMessage = (data: {
      groupId: string;
      userId: string;
      displayName: string;
      message: string;
    }) => {
      const current = activeConvRef.current;
      if (current?.type === "group" && current.id === data.groupId) {
        setTotalMessages((t) => t + 1);
        setMessages((prev) => [
          ...prev,
          { role: "user", content: data.message, senderName: data.displayName },
        ]);
      } else {
        // Not viewing this group — increment unread count
        setUnreadCounts((prev) => ({
          ...prev,
          [data.groupId]: (prev[data.groupId] ?? 0) + 1,
        }));
      }
    };

    const onAdminChange = (data: {
      type: string;
      message: string;
      data: any;
      actorId?: string;
    }) => {
      // Don't toast our own actions
      if (data.actorId === user?.id) return;

      toast(data.message, "info");

      // Update the active conversation view if it's affected
      // (conversations state is updated globally in AuthContext)
      const current = activeConvRef.current;
      switch (data.type) {
        case "group_model_changed": {
          const { groupId, model } = data.data;
          if (current?.type === "group" && current.id === groupId) {
            setActiveConv((prev) => prev ? { ...prev, model } : prev);
          }
          break;
        }
        case "single_chat_model_changed": {
          const { singleChatId, model } = data.data;
          if (current?.type === "single" && current.id === singleChatId) {
            setActiveConv((prev) => prev ? { ...prev, model } : prev);
          }
          break;
        }
        case "group_renamed": {
          const { groupId, name } = data.data;
          if (current?.type === "group" && current.id === groupId) {
            setActiveConv((prev) => prev ? { ...prev, name } : prev);
          }
          break;
        }
      }
    };

    const onConversationsUpdated = (data: any) => {
      if (data.action === "group_added" && data.group) {
        setConversations((prev) => {
          if (!prev) return prev;
          if (prev.groups.some((g) => g.id === data.group.id)) return prev;
          return {
            ...prev,
            groups: [...prev.groups, data.group],
          };
        });
      } else if (data.action === "group_removed" && data.groupId) {
        setConversations((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            groups: prev.groups.filter((g) => g.id !== data.groupId),
          };
        });
      }
    };

    socket.on("thread:typing", onTyping);
    socket.on("chat:reply", onReply);
    socket.on("user:typing", onUserTyping);
    socket.on("group:user-message", onGroupUserMessage);
    socket.on("conversations:updated", onConversationsUpdated);
    socket.on("admin:change", onAdminChange);
    return () => {
      socket.off("thread:typing", onTyping);
      socket.off("chat:reply", onReply);
      socket.off("user:typing", onUserTyping);
      socket.off("group:user-message", onGroupUserMessage);
      socket.off("conversations:updated", onConversationsUpdated);
      socket.off("admin:change", onAdminChange);
    };
  }, [user]);

  const handleSelectConversation = useCallback((conv: ConversationRef) => {
    setActiveConv(conv);
    setSidebarOpen(false);
  }, []);

  // New Chat modal
  const [showNewChat, setShowNewChat] = useState(false);
  const [availableAgents, setAvailableAgents] = useState<AgentListItem[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [creatingChat, setCreatingChat] = useState(false);

  const handleOpenNewChat = useCallback(() => {
    setShowNewChat(true);
    setAgentsLoaded(false);
    getAgentsList()
      .then((agents) => { setAvailableAgents(agents); setAgentsLoaded(true); })
      .catch(() => setAgentsLoaded(true));
  }, []);

  async function handleCreateNewChat(agentId: string) {
    setCreatingChat(true);
    try {
      const sc = await createSingleChat(agentId);
      setConversations((prev) => {
        if (!prev) return prev;
        return { ...prev, singleChats: [sc, ...prev.singleChats] };
      });
      setShowNewChat(false);
      setActiveConv({
        type: "single",
        id: sc.id,
        name: sc.title || "Agent Chat",
        agentId: sc.agentId,
        model: sc.model,
      });
    } catch (err: any) {
      alert(err.message || "Failed to create chat");
    } finally {
      setCreatingChat(false);
    }
  }

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
      setConversations((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          singleChats: prev.singleChats.filter(
            (sc) => sc.id !== deleteTarget.id,
          ),
        };
      });
      if (activeConv?.id === deleteTarget.id) {
        setActiveConv(null);
        setMessages([]);
      }
      setDeleteTarget(null);
    } catch (err: any) {
      alert(err.message || "Failed to delete chat");
    } finally {
      setDeleting(false);
    }
  }

  const handleSend = useCallback(
    async (text: string) => {
      if (!activeConv) return;

      let session = activeSession;
      if (!session) {
        try {
          const scope =
            activeConv.type === "group"
              ? { groupId: activeConv.id }
              : { singleChatId: activeConv.id };
          session = await createSession({
            title: text.slice(0, 60),
            ...scope,
          });
          setActiveSession(session);
        } catch {
          return;
        }
      }

      await doSend(session.threadId, text);
    },
    [activeConv, activeSession],
  );

  async function doSend(threadId: string, text: string) {
    const userMsg: Message = { role: "user", content: text, _absIndex: totalMessages };
    setTotalMessages((t) => t + 1);
    setMessages((prev) => [...prev, userMsg]);
    setSending(true);

    const requestId = crypto.randomUUID();

    // Detect @mention of the agent in group chats
    const isGroup = activeConv?.type === "group";
    const agentDef = isGroup ? activeConv?.agentDefinition : null;
    const mentionsAgent = !isGroup || (
      agentDef
        ? text.toLowerCase().includes(`@${agentDef.toLowerCase()}`)
        : text.includes("@")
    );

    const scope = activeConv
      ? {
          ...(isGroup
            ? { groupId: activeConv.id }
            : { singleChatId: activeConv.id }),
          ...(activeConv.agentId ? { agentId: activeConv.agentId } : {}),
          mentionsAgent,
        }
      : undefined;

    // Group message without @mention — fire and forget (no agent reply expected)
    if (isGroup && !mentionsAgent) {
      try {
        await sendMessage(threadId, text, requestId, scope);
      } catch {
        // stored silently
      } finally {
        setSending(false);
      }
      return;
    }

    // Agent is expected to reply — wait for it
    const replyPromise = new Promise<ChatReplyPayload>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingReplies.current.delete(requestId);
        reject(new Error("Timed out waiting for assistant reply."));
      }, 120_000);

      pendingReplies.current.set(requestId, (p) => {
        window.clearTimeout(timeout);
        resolve(p);
      });
    });

    try {
      await sendMessage(threadId, text, requestId, scope);
      const p = await replyPromise;
      setTotalMessages((t) => t + 1);
      if (p.ok) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: p.reply, vendorSlug: p.vendorSlug, modelName: p.modelName, _absIndex: prev.length > 0 ? (prev[prev.length - 1]._absIndex ?? prev.length - 1) + 1 : 0 },
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
      setSending(false);
    }
  }

  const convName = activeConv?.name || "Select a conversation";
  const agentIsTyping = activeConv
    ? typingConversations.has(activeConv.id)
    : false;

  // Names of users currently typing in the active group
  const usersTypingNames: string[] = activeConv?.type === "group"
    ? Array.from(userTyping.get(activeConv.id)?.values() ?? [])
    : [];

  const handleUserTyping = useCallback(() => {
    if (activeConv?.type === "group") {
      emitUserTyping(activeConv.id);
    }
  }, [activeConv?.type, activeConv?.id]);

  // API already returns only unattached agents
  const filteredAgents = availableAgents;

  return (
    <div className="flex h-dvh bg-gray-50/50 overflow-hidden">
      {/* Mobile sidebar toggle — hidden when sidebar is open */}
      {!sidebarOpen && (
        <button
          onClick={() => setSidebarOpen(true)}
          className="fixed left-3 top-3 z-30 rounded-xl border border-gray-200/80 bg-white/90 p-2.5 shadow-glass backdrop-blur-sm transition-all duration-200 hover:shadow-md sm:hidden active:scale-95"
        >
          <Menu className="h-5 w-5 text-gray-600" />
        </button>
      )}

      {/* Sidebar */}
      <div
        className={`fixed inset-y-0 left-0 z-20 transform transition-transform duration-300 ease-out sm:relative sm:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <SessionSidebar
          groups={conversations?.groups ?? []}
          singleChats={conversations?.singleChats ?? []}
          activeConversationId={activeConv?.id ?? null}
          unreadCounts={unreadCounts}
          typingConversations={typingConversations}
          isAdmin={user?.role === "admin"}
          onSelectConversation={handleSelectConversation}
          onNewChat={handleOpenNewChat}
          onDeleteChat={(id, title) => setDeleteTarget({ id, title })}
          onLogout={logout}
          userName={user?.displayName ?? user?.id ?? null}
        />
      </div>

      {/* Overlay on mobile */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-10 bg-black/20 backdrop-blur-sm sm:hidden animate-fade-in"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main Chat Area */}
      <main className="flex min-w-0 flex-1 flex-col bg-white">
        {/* Chat Header */}
        <header className="flex items-center justify-between border-b border-gray-100 bg-white/80 px-4 py-3.5 backdrop-blur-xl sm:px-6">
          <div className="ml-14 sm:ml-0 min-w-0 flex-1 mr-3">
            <h2 className="text-[13px] sm:text-sm font-semibold text-gray-900 tracking-tight truncate">
              {convName}
            </h2>
            {agentIsTyping ? (
              <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-600">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                Agent is typing...
              </p>
            ) : usersTypingNames.length > 0 ? (
              <p className="flex items-center gap-1.5 text-xs font-medium text-blue-600">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
                </span>
                {usersTypingNames.length === 1
                  ? `${usersTypingNames[0]} is typing...`
                  : `${usersTypingNames.join(", ")} are typing...`}
              </p>
            ) : activeConv?.type === "group" ? (
              <button
                type="button"
                onClick={() => setShowGroupInfo(true)}
                className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500 transition-colors hover:bg-indigo-50 hover:text-indigo-600"
              >
                <Users className="h-3 w-3" />
                {groupMembersList.length + 1} members
                <ChevronRight className="h-2.5 w-2.5" />
              </button>
            ) : (
              <p className="text-xs text-gray-400">
                {activeConv?.type === "single"
                  ? "Direct Chat"
                  : "Default Chat"}
              </p>
            )}
          </div>
          {activeConv && user?.role === "admin" ? (
            <ModelSelector
              currentModel={activeConv.model}
              conversationType={activeConv.type}
              conversationId={activeConv.id}
              onModelChanged={(m: ConversationModelInfo) => {
                setActiveConv((prev) =>
                  prev ? { ...prev, model: m } : prev,
                );
                const conv = activeConvRef.current;
                if (!conv) return;
                setConversations((c) => {
                  if (!c) return c;
                  if (conv.type === "single") {
                    return {
                      ...c,
                      singleChats: c.singleChats.map((sc) =>
                        sc.id === conv.id ? { ...sc, model: m } : sc,
                      ),
                    };
                  }
                  return {
                    ...c,
                    groups: c.groups.map((g) =>
                      g.id === conv.id ? { ...g, model: m } : g,
                    ),
                  };
                });
              }}
            />
          ) : activeConv?.model ? (
            <VendorModelBadge model={activeConv.model} />
          ) : null}
          {activeConv && (
            <button
              onClick={() => {
                setSearchOpen((v) => !v);
                if (searchOpen) {
                  setSearchQuery("");
                  setSearchResults([]);
                  setSearchIdx(-1);
                }
              }}
              className={`ml-2 flex-shrink-0 rounded-xl p-2 transition-all duration-200 ${
                searchOpen
                  ? "bg-indigo-50 text-indigo-600 ring-1 ring-indigo-200/60"
                  : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              }`}
              title="Search in chat"
            >
              <Search className="h-4 w-4" />
            </button>
          )}
        </header>

        {/* Search Bar */}
        {searchOpen && activeConv && (
          <div className="flex items-center justify-center border-b border-gray-100 bg-gray-50/80 px-4 py-2 sm:px-6 animate-slide-up">
            <div className="flex items-center gap-2 w-full max-w-xl rounded-full bg-white px-4 py-1.5 ring-1 ring-gray-200/80 shadow-sm">
            <Search className="h-4 w-4 flex-shrink-0 text-gray-400" />
            <input
              autoFocus
              type="text"
              value={searchQuery}
              onChange={(e) => {
                const val = e.target.value;
                setSearchQuery(val);
                clearTimeout(searchTimer.current);
                if (!val.trim()) {
                  setSearchResults([]);
                  setSearchIdx(-1);
                  return;
                }
                searchTimer.current = setTimeout(() => handleSearch(val), 300);
              }}
              onKeyDown={(e) => {
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
              className="flex-1 bg-transparent text-sm text-gray-900 placeholder-gray-400 outline-none"
            />
            {searching && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
            {searchResults.length > 0 && (
              <div className="flex items-center gap-1">
                <span className="text-xs text-gray-500 tabular-nums whitespace-nowrap">
                  {searchIdx + 1} / {searchResults.length}
                </span>
                <button
                  onClick={() => handleSearchNav("prev")}
                  className="rounded-lg p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600 transition"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => handleSearchNav("next")}
                  className="rounded-lg p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600 transition"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {searchQuery && searchResults.length === 0 && !searching && (
              <span className="text-xs text-gray-400">No results</span>
            )}
            <button
              onClick={() => {
                setSearchOpen(false);
                setSearchQuery("");
                setSearchResults([]);
                setSearchIdx(-1);
              }}
              className="rounded-lg p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600 transition"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            </div>
          </div>
        )}

        {/* Messages Area */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          {!activeConv && !sending && (
            <div className="flex h-full flex-col items-center justify-center text-center animate-fade-in">
              <div className="mb-5 flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-indigo-50 to-blue-50 shadow-glass">
                <Sparkles className="h-9 w-9 text-indigo-400" />
              </div>
              <h3 className="mb-1.5 text-lg font-bold text-gray-900 tracking-tight">
                Select a conversation
              </h3>
              <p className="max-w-xs text-sm text-gray-500 leading-relaxed">
                Choose a group or direct chat from the sidebar to start
                messaging.
              </p>
            </div>
          )}

          {activeConv && loadingHistory && (
            <div className="flex h-full flex-col items-center justify-center animate-fade-in">
              <Loader2 className="h-8 w-8 animate-spin text-indigo-400" />
              <p className="mt-3 text-sm text-gray-400">
                Loading conversation...
              </p>
            </div>
          )}

          {activeConv &&
            messages.length === 0 &&
            !sending &&
            !loadingHistory && (
              <div className="flex h-full flex-col items-center justify-center text-center animate-fade-in">
                <div className="mb-5 flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-indigo-50 to-blue-50 shadow-glass">
                  <Sparkles className="h-9 w-9 text-indigo-400" />
                </div>
                <h3 className="mb-1.5 text-lg font-bold text-gray-900 tracking-tight">
                  {convName}
                </h3>
                <p className="max-w-xs text-sm text-gray-500 leading-relaxed">
                  Send a message to start the conversation.
                </p>
              </div>
            )}

          <div className="mx-auto max-w-3xl space-y-5">
            {/* Top sentinel for infinite scroll */}
            <div ref={topSentinelRef} className="h-1" />

            {/* Load more indicator */}
            {loadingMore && (
              <div className="flex justify-center py-3 animate-fade-in">
                <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
              </div>
            )}
            {hasMoreMessages && !loadingMore && (
              <div className="flex justify-center">
                <button
                  onClick={handleLoadMore}
                  className="rounded-full bg-gray-100 px-3 py-1 text-[11px] font-medium text-gray-500 transition hover:bg-gray-200 hover:text-gray-700"
                >
                  Load older messages
                </button>
              </div>
            )}

            {messages.map((msg, i) => {
              const absIdx = msg._absIndex ?? i;
              const isSearchMatch = searchQuery && searchResults.some((r) => r.index === absIdx);
              return (
                <div key={absIdx} data-msg-index={absIdx} className={isSearchMatch ? "search-match-highlight rounded-2xl transition-colors duration-300" : ""}>
                  <ChatMessage role={msg.role} content={msg.content} senderName={msg.senderName} vendorSlug={msg.vendorSlug ?? activeConv?.model?.vendor?.slug} modelName={msg.modelName ?? activeConv?.model?.name} isGroup={activeConv?.type === "group"} highlightText={searchQuery && isSearchMatch ? searchQuery : undefined} />
                </div>
              );
            })}

            {(sending || agentIsTyping) && (
              <div className="flex justify-start animate-fade-in">
                <div className={`mr-3 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl shadow-sm ring-1 ${
                  activeConv?.model?.vendor?.slug === "openai" ? "bg-emerald-50 text-emerald-700 ring-emerald-200/60" :
                  activeConv?.model?.vendor?.slug === "anthropic" ? "bg-amber-50 text-amber-700 ring-amber-200/60" :
                  activeConv?.model?.vendor?.slug === "google" ? "bg-blue-50 text-blue-700 ring-blue-200/60" :
                  "bg-gray-100 text-gray-500 ring-gray-200/60"
                }`}>
                  <VendorIcon slug={activeConv?.model?.vendor?.slug ?? ""} />
                </div>
                <div className="rounded-2xl rounded-tl-md bg-white px-4 py-3 shadow-glass ring-1 ring-gray-950/[0.04]">
                  <div className="flex gap-1.5">
                    <div className="h-2 w-2 animate-bounce rounded-full bg-gray-300 [animation-delay:-0.3s]" />
                    <div className="h-2 w-2 animate-bounce rounded-full bg-gray-300 [animation-delay:-0.15s]" />
                    <div className="h-2 w-2 animate-bounce rounded-full bg-gray-300" />
                  </div>
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </div>

        {/* Input Bar */}
        <ChatInput
          onSend={handleSend}
          onTyping={handleUserTyping}
          disabled={sending || !activeConv}
          placeholder={
            activeConv?.type === "group" && activeConv.agentDefinition
              ? `Message... use @ to tag agent`
              : undefined
          }
          agentName={activeConv?.type === "group" ? (activeConv.agentDefinition ?? undefined) : undefined}
          vendorSlug={activeConv?.type === "group" ? (activeConv.model?.vendor?.slug ?? undefined) : undefined}
        />
      </main>

      {/* New Chat Modal */}
      {showNewChat && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-sm animate-scale-in rounded-t-2xl sm:rounded-2xl border border-gray-200/60 bg-white/95 p-5 sm:p-6 shadow-glass-lg backdrop-blur-xl mx-0 sm:mx-4">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-base font-bold text-gray-900">New Chat</h3>
                <p className="text-xs text-gray-500">
                  Choose an agent to start a conversation with.
                </p>
              </div>
              <button
                onClick={() => setShowNewChat(false)}
                className="rounded-xl p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {!agentsLoaded ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-gray-300" />
              </div>
            ) : filteredAgents.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-400">
                No available agents. Ask an admin to create one first.
              </p>
            ) : (
              <div className="max-h-60 space-y-1 overflow-y-auto">
                {filteredAgents.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => handleCreateNewChat(a.id)}
                    disabled={creatingChat}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm transition-all duration-150 hover:bg-indigo-50/70 active:scale-[0.98] disabled:opacity-50"
                  >
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-sm">
                      <Sparkles className="h-4 w-4" />
                    </div>
                    <span className="font-medium text-gray-900">
                      {a.definition || `Agent ${a.id.slice(0, 8)}`}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Group Info Panel */}
      {showGroupInfo && activeConv?.type === "group" && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in"
          onClick={() => setShowGroupInfo(false)}
        >
          <div
            className="w-full max-w-sm animate-scale-in rounded-t-2xl sm:rounded-2xl border border-gray-200/60 bg-white/95 p-5 sm:p-6 shadow-glass-lg backdrop-blur-xl mx-0 sm:mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-md">
                  <Users className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-gray-900">{activeConv.name}</h3>
                  <p className="text-[11px] text-gray-400">
                    {groupMembersList.length} member{groupMembersList.length !== 1 ? "s" : ""} + 1 agent
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowGroupInfo(false)}
                className="rounded-xl p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Agent */}
            {activeConv.agentDefinition && (
              <div className="mb-4">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Agent</p>
                <div className="flex items-center gap-3 rounded-xl bg-gradient-to-r from-gray-50 to-indigo-50/50 p-3 ring-1 ring-gray-100">
                  <div
                    className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl shadow-sm ring-1 ${
                      activeConv.model?.vendor?.slug === "openai" ? "bg-emerald-50 text-emerald-600 ring-emerald-200/60" :
                      activeConv.model?.vendor?.slug === "anthropic" ? "bg-amber-50 text-amber-600 ring-amber-200/60" :
                      activeConv.model?.vendor?.slug === "google" ? "bg-blue-50 text-blue-600 ring-blue-200/60" :
                      "bg-violet-50 text-violet-600 ring-violet-200/60"
                    }`}
                  >
                    {activeConv.model?.vendor?.slug ? (
                      <VendorIcon slug={activeConv.model.vendor.slug} />
                    ) : (
                      <Bot className="h-4 w-4" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900 truncate">{activeConv.agentDefinition}</p>
                    {activeConv.model && (
                      <p className="text-[11px] text-gray-400 truncate">{activeConv.model.vendor?.name} &middot; {activeConv.model.name}</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Members */}
            <div>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Members</p>
              <div className="max-h-60 space-y-1 overflow-y-auto">
                {groupMembersList.map((m) => {
                  const name = m.displayName || m.userId;
                  const isCurrentUser = m.userId === user?.id;
                  return (
                    <div
                      key={m.userId}
                      className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-gray-50"
                    >
                      <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl text-xs font-bold shadow-sm ring-1 ring-gray-950/[0.04] ${
                        isCurrentUser
                          ? "bg-gradient-to-br from-indigo-100 to-blue-100 text-indigo-600"
                          : "bg-gradient-to-br from-gray-100 to-gray-200 text-gray-600"
                      }`}>
                        {name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {name}
                          {isCurrentUser && (
                            <span className="ml-1.5 text-[10px] font-semibold text-indigo-500">you</span>
                          )}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Chat Confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-sm animate-scale-in rounded-t-2xl sm:rounded-2xl border border-gray-200/60 bg-white/95 p-5 sm:p-6 shadow-glass-lg backdrop-blur-xl mx-0 sm:mx-4">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-red-100">
              <AlertTriangle className="h-6 w-6 text-red-500" />
            </div>
            <h3 className="mb-1 text-base font-bold text-gray-900">
              Delete "{deleteTarget.title}"?
            </h3>
            <p className="mb-5 text-sm text-gray-500 leading-relaxed">
              This will permanently delete{" "}
              <strong className="text-gray-700">
                all conversation history
              </strong>
              ,{" "}
              <strong className="text-gray-700">agent memory</strong>, and{" "}
              <strong className="text-gray-700">episodic context</strong>{" "}
              associated with this chat. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2.5">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 transition-all duration-200 hover:bg-gray-50 active:scale-[0.98]"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={deleting}
                className="rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-red-700 active:scale-[0.98] disabled:opacity-50"
              >
                {deleting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Delete permanently"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
