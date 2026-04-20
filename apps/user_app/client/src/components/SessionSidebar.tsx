import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import {
  MessageCircle,
  Users,
  Settings,
  LogOut,
  Trash2,
  Sparkles,
  MessagesSquare,
} from "lucide-react";
import logo from "../assets/logo.svg";
import { useNavigate } from "react-router-dom";
import { flushSync } from "react-dom";
import type {
  GroupConversation,
  SingleChatConversation,
  ConversationModelInfo,
} from "../api";
import { VendorIcon } from "./VendorModelBadge";

export interface ConversationRef {
  type: "group" | "single";
  id: string;
  name: string;
  agentId: string;
  agentDefinition?: string | null;
  model: ConversationModelInfo | null;
}


interface SessionSidebarProps {
  /** Clears or sets the open chat; call with `null` before leaving chat (e.g. Admin). */
  setActiveConversation: React.Dispatch<
    React.SetStateAction<ConversationRef | null>
  >;
  groups: GroupConversation[];
  singleChats: SingleChatConversation[];
  activeConversationId: string | null;
  unreadCounts: Record<string, number>;
  typingConversations: Set<string>;
  epicTypingConversations: Set<string>;
  isAdmin?: boolean;
  onSelectConversation: (conv: ConversationRef) => void;
  onDeleteChat: (chatId: string, chatTitle: string) => void;
  onLogout: () => void;
  userName: string | null;
  /** Organization logo (base64 data URL) — replaces the default logo.svg when set. */
  orgLogo?: string | null;
  /** Organization name — replaces the hardcoded brand name when set. */
  orgName?: string | null;
}

/** Small vendor icon used as the conversation avatar in the sidebar. */
function VendorChatIcon({ model, isActive }: { model: ConversationModelInfo | null; isActive: boolean }) {
  const slug = model?.vendor?.slug;

  if (!slug) {
    return (
      <Box
        className={`mr-2.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ring-1 ${
          isActive
            ? "bg-indigo-500/30 text-indigo-100 ring-indigo-400/40"
            : "bg-white/5 text-indigo-200/70 ring-white/10"
        }`}
      >
        <MessageCircle className="h-3.5 w-3.5" />
      </Box>
    );
  }

  const colorMap: Record<string, { active: string; idle: string }> = {
    openai: {
      active: "bg-emerald-400/25 text-emerald-100 ring-emerald-300/40",
      idle: "bg-emerald-400/10 text-emerald-200/80 ring-emerald-300/20",
    },
    anthropic: {
      active: "bg-amber-400/25 text-amber-100 ring-amber-300/40",
      idle: "bg-amber-400/10 text-amber-200/80 ring-amber-300/20",
    },
    google: {
      active: "bg-sky-400/25 text-sky-100 ring-sky-300/40",
      idle: "bg-sky-400/10 text-sky-200/80 ring-sky-300/20",
    },
  };
  const colors = colorMap[slug] ?? {
    active: "bg-indigo-500/30 text-indigo-100 ring-indigo-400/40",
    idle: "bg-white/5 text-indigo-200/70 ring-white/10",
  };

  return (
    <Box
      className={`mr-2.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ring-1 ${
        isActive ? colors.active : colors.idle
      }`}
    >
      <VendorIcon slug={slug} />
    </Box>
  );
}

export default function SessionSidebar({
  setActiveConversation,
  groups,
  singleChats,
  activeConversationId,
  unreadCounts,
  typingConversations,
  epicTypingConversations,
  isAdmin,
  onSelectConversation,
  onDeleteChat,
  onLogout,
  userName,
  orgLogo,
  orgName,
}: SessionSidebarProps) {
  const navigate = useNavigate();

  return (
    <Stack
      component="aside"
      className="glass-panel-elevated"
      sx={{
        height: "100%",
        width: 288,
        position: "relative",
        overflow: "hidden",
        borderRight: "1px solid rgba(255,255,255,0.08)",
        borderTop: 0,
        borderBottom: 0,
        borderLeft: 0,
      }}
    >
      {/* Header */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1.5}
        sx={{ px: 2.5, py: 2, position: "relative", zIndex: 1 }}
      >
        <Box sx={{ position: "relative" }}>
          <Box
            className="absolute -inset-1 rounded-2xl bg-gradient-to-br from-indigo-500/40 via-violet-500/30 to-fuchsia-500/30 blur-md"
            aria-hidden
          />
          <Box
            component="img"
            src={orgLogo || logo}
            alt="Logo"
            className="relative h-9 w-9 rounded-xl object-cover ring-1 ring-white/20"
          />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Box
            component="span"
            className="block text-sm font-bold tracking-tight text-white"
            sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {orgName || "GrahamyClaw"}
          </Box>
          <Stack
            direction="row"
            alignItems="center"
            spacing={0.5}
            className="text-[10px] font-medium uppercase tracking-[0.14em] text-indigo-200/60"
          >
            <Sparkles className="h-2.5 w-2.5 text-indigo-300/70" />
            <span>Agent Platform</span>
          </Stack>
        </Box>
      </Stack>

      {/* Divider line */}
      <Box
        sx={{
          mx: 2,
          height: "1px",
          background:
            "linear-gradient(to right, transparent, rgba(129,140,248,0.35), transparent)",
        }}
      />

      {/* Conversation List */}
      <Box
        component="nav"
        className="dark-scroll"
        sx={{ flex: 1, overflowY: "auto", px: 1.5, py: 1.5, position: "relative", zIndex: 1 }}
      >
        {/* Direct Chats */}
        {singleChats.length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Stack
              direction="row"
              alignItems="center"
              spacing={0.75}
              className="text-[10px] font-semibold uppercase tracking-[0.16em] text-indigo-300/60"
              sx={{ mb: 1, px: 1.5 }}
            >
              <MessageCircle className="h-3 w-3" />
              <span>Direct Chats</span>
            </Stack>
            {singleChats.map((sc) => {
              const isActive = activeConversationId === sc.id;
              const unread = unreadCounts[sc.id] ?? 0;
              const isTyping = typingConversations.has(sc.id);
              const isEpic = epicTypingConversations.has(sc.id);
              return (
                <Stack
                  key={sc.id}
                  direction="row"
                  alignItems="center"
                  className={`conv-row group mb-1 rounded-xl text-sm ${
                    isActive ? "conv-row-active" : "conv-row-idle"
                  }`}
                >
                  <Stack
                    component="button"
                    direction="row"
                    alignItems="center"
                    onClick={() =>
                      onSelectConversation({
                        type: "single",
                        id: sc.id,
                        name: sc.title || "Agent Chat",
                        agentId: sc.agentId,
                        model: sc.model,
                      })
                    }
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      px: 1.5,
                      py: 1.25,
                      textAlign: "left",
                      cursor: "pointer",
                      background: "transparent",
                      border: 0,
                      color: "inherit",
                    }}
                  >
                    <VendorChatIcon model={sc.model} isActive={isActive} />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Box
                        component="span"
                        className={`block truncate text-[13px] ${
                          isActive ? "font-semibold" : "font-medium"
                        }`}
                      >
                        {sc.title || "Agent Chat"}
                      </Box>
                      {isTyping && (
                        <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mt: 0.25 }}>
                          <Box
                            className={`typing-dot h-1.5 w-1.5 rounded-full ${
                              isEpic ? "bg-fuchsia-300" : "bg-indigo-300"
                            }`}
                          />
                          <Box
                            component="span"
                            className={`text-[10px] font-medium ${
                              isEpic ? "text-fuchsia-200/90" : "text-indigo-200/90"
                            }`}
                          >
                            {isEpic ? "executing epic..." : "typing..."}
                          </Box>
                        </Stack>
                      )}
                    </Box>
                    {unread > 0 && (
                      <Box
                        component="span"
                        className="flex items-center justify-center rounded-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 text-[10px] font-bold text-white"
                        sx={{
                          ml: 1,
                          height: 20,
                          minWidth: 20,
                          px: 0.75,
                          boxShadow: "0 0 10px rgba(168,85,247,0.55)",
                        }}
                      >
                        {unread > 99 ? "99+" : unread}
                      </Box>
                    )}
                  </Stack>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteChat(sc.id, sc.title || "Agent Chat");
                    }}
                    className="mr-2 rounded-lg p-1.5 text-indigo-200/30 opacity-0 transition-all duration-150 group-hover:opacity-100 hover:bg-red-500/20 hover:text-red-300"
                    title="Clear conversation"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </Stack>
              );
            })}
          </Box>
        )}

        {/* Groups */}
        {groups.length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Stack
              direction="row"
              alignItems="center"
              spacing={0.75}
              className="text-[10px] font-semibold uppercase tracking-[0.16em] text-indigo-300/60"
              sx={{ mb: 1, px: 1.5 }}
            >
              <Users className="h-3 w-3" />
              <span>Groups</span>
            </Stack>
            {groups.map((g) => {
              const isActive = activeConversationId === g.id;
              const unread = unreadCounts[g.id] ?? 0;
              const isTyping = typingConversations.has(g.id);
              const isEpic = epicTypingConversations.has(g.id);
              return (
                <Stack
                  key={g.id}
                  component="button"
                  direction="row"
                  alignItems="center"
                  onClick={() =>
                    onSelectConversation({
                      type: "group",
                      id: g.id,
                      name: g.name,
                      agentId: g.agentId,
                      agentDefinition: g.agentDefinition,
                      model: g.model,
                    })
                  }
                  className={`conv-row mb-1 w-full rounded-xl text-left text-sm ${
                    isActive ? "conv-row-active" : "conv-row-idle"
                  }`}
                  sx={{
                    px: 1.5,
                    py: 1.25,
                    cursor: "pointer",
                    background: "transparent",
                    border: 0,
                  }}
                >
                  <VendorChatIcon model={g.model} isActive={isActive} />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Box
                      component="span"
                      className={`block truncate text-[13px] ${
                        isActive ? "font-semibold" : "font-medium"
                      }`}
                    >
                      {g.name}
                    </Box>
                    {isTyping && (
                      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mt: 0.25 }}>
                        <Box
                          className={`typing-dot h-1.5 w-1.5 rounded-full ${
                            isEpic ? "bg-fuchsia-300" : "bg-indigo-300"
                          }`}
                        />
                        <Box
                          component="span"
                          className={`text-[10px] font-medium ${
                            isEpic ? "text-fuchsia-200/90" : "text-indigo-200/90"
                          }`}
                        >
                          {isEpic ? "executing epic..." : "typing..."}
                        </Box>
                      </Stack>
                    )}
                  </Box>
                  {unread > 0 && (
                    <Box
                      component="span"
                      className="flex items-center justify-center rounded-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 text-[10px] font-bold text-white"
                      sx={{
                        ml: 1,
                        height: 20,
                        minWidth: 20,
                        px: 0.75,
                        boxShadow: "0 0 10px rgba(168,85,247,0.55)",
                      }}
                    >
                      {unread > 99 ? "99+" : unread}
                    </Box>
                  )}
                </Stack>
              );
            })}
          </Box>
        )}

        {/* Empty state */}
        {groups.length === 0 && singleChats.length === 0 && (
          <Stack alignItems="center" justifyContent="center" sx={{ py: 6, textAlign: "center" }}>
            <Box
              className="relative mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/20 to-violet-500/20 ring-1 ring-white/10"
            >
              <Box
                className="absolute inset-0 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-fuchsia-500/10 blur-md"
                aria-hidden
              />
              <MessageCircle className="relative h-5 w-5 text-indigo-200/70" />
            </Box>
            <Box component="p" className="text-xs text-indigo-200/70">
              No conversations yet
            </Box>
            <Box component="p" className="mt-0.5 text-[10px] text-indigo-300/40">
              Start a new chat above
            </Box>
          </Stack>
        )}
      </Box>

      {/* Roundtable link — featured nav item */}
      <Box sx={{ px: 1.5, pt: 0.5, pb: 0.25, position: "relative", zIndex: 1 }}>
        <button
          type="button"
          onClick={() => {
            flushSync(() => {
              setActiveConversation(null);
            });
            navigate("/roundtable");
          }}
          className="group relative flex w-full items-center gap-2.5 overflow-hidden rounded-xl border border-fuchsia-400/25 bg-gradient-to-r from-indigo-500/15 via-violet-500/15 to-fuchsia-500/15 px-3 py-2.5 text-left text-sm font-semibold text-white transition-all duration-200 hover:border-fuchsia-400/50 hover:shadow-[0_0_24px_-6px_rgba(217,70,239,0.55)]"
        >
          <Box
            className="absolute -inset-1 -z-10 rounded-xl bg-gradient-to-r from-indigo-500/30 via-violet-500/30 to-fuchsia-500/30 opacity-0 blur-md transition-opacity duration-300 group-hover:opacity-100"
            aria-hidden
          />
          <Box
            component="span"
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 text-white ring-1 ring-white/20"
            sx={{ boxShadow: "0 0 12px rgba(168,85,247,0.55)" }}
          >
            <MessagesSquare className="h-3.5 w-3.5" />
          </Box>
          <Box component="span" sx={{ flex: 1 }}>
            Roundtables
          </Box>
          <Box
            component="span"
            className="text-[9px] font-bold uppercase tracking-[0.14em] text-fuchsia-200/80"
          >
            multi-agent
          </Box>
        </button>
      </Box>

      {/* Admin link */}
      {isAdmin && (
        <Box sx={{ px: 1.5, py: 0.5, position: "relative", zIndex: 1 }}>
          <button
            type="button"
            onClick={() => {
              flushSync(() => {
                setActiveConversation(null);
              });
              navigate("/admin");
            }}
            className="flex w-full items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-left text-sm font-medium text-indigo-100/80 transition-all duration-200 hover:border-indigo-300/30 hover:bg-indigo-500/10 hover:text-white hover:shadow-[0_0_16px_rgba(99,102,241,0.25)]"
          >
            <Settings className="h-4 w-4" />
            Admin Panel
          </button>
        </Box>
      )}

      {/* User Footer */}
      <Box
        className="safe-bottom"
        sx={{
          px: 2,
          py: 1.5,
          pb: { xs: 2.5, sm: 1.5 },
          position: "relative",
          zIndex: 1,
          borderTop: "1px solid rgba(255,255,255,0.06)",
          background: "linear-gradient(to top, rgba(15,23,42,0.6), transparent)",
        }}
      >
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Stack direction="row" alignItems="center" spacing={1.25}>
            <Box
              className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 text-xs font-bold text-white ring-1 ring-white/20"
              sx={{ boxShadow: "0 0 14px rgba(99,102,241,0.4)" }}
            >
              {(userName || "U").charAt(0).toUpperCase()}
            </Box>
            <Box
              component="span"
              className="text-[13px] font-medium text-white/90"
              sx={{
                maxWidth: 120,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {userName || "User"}
            </Box>
          </Stack>
          <button
            onClick={onLogout}
            className="rounded-xl p-2 text-indigo-200/50 transition-all duration-150 hover:bg-red-500/20 hover:text-red-300"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </Stack>
      </Box>
    </Stack>
  );
}
