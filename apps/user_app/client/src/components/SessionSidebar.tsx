import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import {
  MessageCircle,
  Users,
  Settings,
  LogOut,
  Trash2,
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
}

/** Small vendor icon used as the conversation avatar in the sidebar. */
function VendorChatIcon({ model, isActive }: { model: ConversationModelInfo | null; isActive: boolean }) {
  const slug = model?.vendor?.slug;

  if (!slug) {
    return (
      <Box
        className={`mr-2.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ${isActive ? "bg-indigo-100 text-indigo-600" : "bg-gray-100 text-gray-400"
          }`}
      >
        <MessageCircle className="h-3.5 w-3.5" />
      </Box>
    );
  }

  const colorMap: Record<string, { active: string; idle: string }> = {
    openai: { active: "bg-emerald-100 text-emerald-700", idle: "bg-emerald-50 text-emerald-600" },
    anthropic: { active: "bg-amber-100 text-amber-700", idle: "bg-amber-50 text-amber-600" },
    google: { active: "bg-blue-100 text-blue-700", idle: "bg-blue-50 text-blue-600" },
  };
  const colors = colorMap[slug] ?? { active: "bg-indigo-100 text-indigo-600", idle: "bg-gray-100 text-gray-500" };

  return (
    <Box
      className={`mr-2.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ${isActive ? colors.active : colors.idle
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
}: SessionSidebarProps) {
  const navigate = useNavigate();

  return (
    <Stack
      component="aside"
      className="bg-gradient-to-b from-slate-50 to-gray-50 border-r border-gray-200/80"
      sx={{ height: "100%", width: 288 }}
    >
      {/* Header */}
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ px: 2.5, py: 2 }}>
        <img src={logo} alt="Logo" className="h-9 w-9 rounded-xl shadow-md shadow-indigo-200/50 object-cover" />
        <Box>
          <Box component="span" className="text-sm font-bold text-gray-900 tracking-tight">
            GrahamyClaw
          </Box>
          <Box component="span" className="block text-[10px] font-medium text-gray-400">
            Agent Management Interaction Platform
          </Box>
        </Box>
      </Stack>

      {/* Conversation List */}
      <Box component="nav" sx={{ flex: 1, overflowY: "auto", px: 1.5, py: 1 }}>
        {/* Direct Chats */}
        {singleChats.length > 0 && (
          <Box sx={{ mb: 1.5 }}>
            <Stack direction="row" alignItems="center" spacing={0.75} className="text-[11px] font-semibold uppercase tracking-wider text-gray-400" sx={{ mb: 0.75, px: 1.5 }}>
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
                  className={`group mb-0.5 rounded-xl text-sm transition-all duration-150 ${isActive
                    ? "bg-gradient-to-r from-indigo-50 to-blue-50 font-medium text-indigo-700 shadow-sm ring-1 ring-indigo-100"
                    : "text-gray-600 hover:bg-white hover:shadow-sm hover:ring-1 hover:ring-gray-100"
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
                    sx={{ flex: 1, minWidth: 0, px: 1.5, py: 1.25, textAlign: "left", cursor: "pointer" }}
                  >
                    <VendorChatIcon model={sc.model} isActive={isActive} />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Box component="span" className="block truncate text-[13px]">
                        {sc.title || "Agent Chat"}
                      </Box>
                      {isTyping && (
                        <Box component="span" className={`block text-[10px] font-medium ${isEpic ? "text-violet-500" : "text-emerald-500"} animate-pulse-soft`}>
                          {isEpic ? "executing epic..." : "typing..."}
                        </Box>
                      )}
                    </Box>
                    {unread > 0 && (
                      <Box
                        component="span"
                        className="flex items-center justify-center rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 text-[10px] font-bold text-white shadow-sm"
                        sx={{ ml: 1, height: 20, minWidth: 20, px: 0.75 }}
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
                      className="mr-2 rounded-lg p-1.5 text-gray-300 opacity-0 transition-all duration-150 group-hover:opacity-100 hover:bg-red-50 hover:text-red-500"
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
          <Box sx={{ mb: 1.5 }}>
            <Stack direction="row" alignItems="center" spacing={0.75} className="text-[11px] font-semibold uppercase tracking-wider text-gray-400" sx={{ mb: 0.75, px: 1.5 }}>
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
                  className={`mb-0.5 w-full rounded-xl text-left text-sm transition-all duration-150 ${isActive
                    ? "bg-gradient-to-r from-indigo-50 to-blue-50 font-medium text-indigo-700 shadow-sm ring-1 ring-indigo-100"
                    : "text-gray-600 hover:bg-white hover:shadow-sm hover:ring-1 hover:ring-gray-100"
                    }`}
                  sx={{ px: 1.5, py: 1.25, cursor: "pointer" }}
                >
                  <VendorChatIcon model={g.model} isActive={isActive} />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Box component="span" className="block truncate text-[13px]">{g.name}</Box>
                    {isTyping && (
                      <Box component="span" className={`block text-[10px] font-medium ${isEpic ? "text-violet-500" : "text-emerald-500"} animate-pulse-soft`}>
                        {isEpic ? "executing epic..." : "typing..."}
                      </Box>
                    )}
                  </Box>
                  {unread > 0 && (
                    <Box
                      component="span"
                      className="flex items-center justify-center rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 text-[10px] font-bold text-white shadow-sm"
                      sx={{ ml: 1, height: 20, minWidth: 20, px: 0.75 }}
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
            <Box className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-100">
              <MessageCircle className="h-5 w-5 text-gray-300" />
            </Box>
            <Box component="p" className="text-xs text-gray-400">No conversations yet</Box>
            <Box component="p" className="text-[10px] text-gray-300 mt-0.5">
              Start a new chat above
            </Box>
          </Stack>
        )}
      </Box>

      {/* Admin link */}
      {isAdmin && (
        <Box sx={{ px: 1.5, py: 0.5 }}>
          <button
            type="button"
            onClick={() => {
              flushSync(() => {
                setActiveConversation(null);
              });
              navigate("/admin");
            }}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-gray-500 transition-all duration-150 hover:bg-white hover:text-gray-700 hover:shadow-sm"
          >
            <Settings className="h-4 w-4" />
            Admin Panel
          </button>
        </Box>
      )}

      {/* User Footer */}
      <Box
        className="border-t border-gray-200/60 safe-bottom"
        sx={{ px: 2, py: 1.5, pb: { xs: 2.5, sm: 1.5 } }}
      >
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Stack direction="row" alignItems="center" spacing={1.25}>
            <Box className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-gray-200 to-gray-300 text-xs font-bold text-gray-600 shadow-sm">
              {(userName || "U").charAt(0).toUpperCase()}
            </Box>
            <Box
              component="span"
              className="text-[13px] font-medium text-gray-700"
              sx={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {userName || "User"}
            </Box>
          </Stack>
          <button
            onClick={onLogout}
            className="rounded-xl p-2 text-gray-400 transition-all duration-150 hover:bg-red-50 hover:text-red-500"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </Stack>
      </Box>
    </Stack>
  );
}
