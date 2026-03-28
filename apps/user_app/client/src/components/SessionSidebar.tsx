import {
  Plus,
  MessageCircle,
  Users,
  Settings,
  LogOut,
  Trash2,
} from "lucide-react";
import logo from "../assets/logo.svg";
import { Link } from "react-router-dom";
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
  groups: GroupConversation[];
  singleChats: SingleChatConversation[];
  activeConversationId: string | null;
  unreadCounts: Record<string, number>;
  typingConversations: Set<string>;
  isAdmin?: boolean;
  onSelectConversation: (conv: ConversationRef) => void;
  onNewChat: () => void;
  onDeleteChat: (chatId: string, chatTitle: string) => void;
  onLogout: () => void;
  userName: string | null;
}

/** Small vendor icon used as the conversation avatar in the sidebar. */
function VendorChatIcon({ model, isActive }: { model: ConversationModelInfo | null; isActive: boolean }) {
  const slug = model?.vendor?.slug;

  if (!slug) {
    // No model assigned — fall back to generic icon
    return (
      <div
        className={`mr-2.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ${
          isActive ? "bg-indigo-100 text-indigo-600" : "bg-gray-100 text-gray-400"
        }`}
      >
        <MessageCircle className="h-3.5 w-3.5" />
      </div>
    );
  }

  const colorMap: Record<string, { active: string; idle: string }> = {
    openai: { active: "bg-emerald-100 text-emerald-700", idle: "bg-emerald-50 text-emerald-600" },
    anthropic: { active: "bg-amber-100 text-amber-700", idle: "bg-amber-50 text-amber-600" },
    google: { active: "bg-blue-100 text-blue-700", idle: "bg-blue-50 text-blue-600" },
  };
  const colors = colorMap[slug] ?? { active: "bg-indigo-100 text-indigo-600", idle: "bg-gray-100 text-gray-500" };

  return (
    <div
      className={`mr-2.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ${
        isActive ? colors.active : colors.idle
      }`}
    >
      <VendorIcon slug={slug} />
    </div>
  );
}

export default function SessionSidebar({
  groups,
  singleChats,
  activeConversationId,
  unreadCounts,
  typingConversations,
  isAdmin,
  onSelectConversation,
  onNewChat,
  onDeleteChat,
  onLogout,
  userName,
}: SessionSidebarProps) {
  return (
    <aside className="flex h-full w-72 flex-col bg-gradient-to-b from-slate-50 to-gray-50 border-r border-gray-200/80">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4">
        <img src={logo} alt="Logo" className="h-9 w-9 rounded-xl shadow-md shadow-indigo-200/50 object-cover" />
        <div>
          <span className="text-sm font-bold text-gray-900 tracking-tight">
            GrahamyClaw
          </span>
          <span className="block text-[10px] font-medium text-gray-400">
            Grahamy's agents interaction platform
          </span>
        </div>
      </div>

      {/* New Chat Button */}
      <div className="px-3 pb-2">
        <button
          onClick={onNewChat}
          className="flex w-full items-center gap-2.5 rounded-xl border border-gray-200/80 bg-white px-3.5 py-2.5 text-sm font-medium text-gray-700 shadow-glass transition-all duration-200 hover:border-indigo-200 hover:bg-indigo-50/50 hover:text-indigo-700 hover:shadow-md active:scale-[0.98]"
        >
          <Plus className="h-4 w-4" />
          New Chat
        </button>
      </div>

      {/* Conversation List */}
      <nav className="flex-1 overflow-y-auto px-3 py-2">
        {/* Direct Chats */}
        {singleChats.length > 0 && (
          <div className="mb-3">
            <h3 className="mb-1.5 flex items-center gap-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              <MessageCircle className="h-3 w-3" />
              Direct Chats
            </h3>
            {singleChats.map((sc) => {
              const isActive = activeConversationId === sc.id;
              const unread = unreadCounts[sc.id] ?? 0;
              const isTyping = typingConversations.has(sc.id);
              return (
                <div
                  key={sc.id}
                  className={`group mb-0.5 flex items-center rounded-xl text-sm transition-all duration-150 ${
                    isActive
                      ? "bg-gradient-to-r from-indigo-50 to-blue-50 font-medium text-indigo-700 shadow-sm ring-1 ring-indigo-100"
                      : "text-gray-600 hover:bg-white hover:shadow-sm hover:ring-1 hover:ring-gray-100"
                  }`}
                >
                  <button
                    onClick={() =>
                      onSelectConversation({
                        type: "single",
                        id: sc.id,
                        name: sc.title || "Agent Chat",
                        agentId: sc.agentId,
                        model: sc.model,
                      })
                    }
                    className="flex flex-1 items-center px-3 py-2.5 text-left min-w-0"
                  >
                    <VendorChatIcon model={sc.model} isActive={isActive} />
                    <div className="flex-1 min-w-0">
                      <span className="block truncate text-[13px]">
                        {sc.title || "Agent Chat"}
                      </span>
                      {isTyping && (
                        <span className="block text-[10px] font-medium text-emerald-500 animate-pulse-soft">
                          typing...
                        </span>
                      )}
                    </div>
                    {unread > 0 && (
                      <span className="ml-2 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 px-1.5 text-[10px] font-bold text-white shadow-sm">
                        {unread > 99 ? "99+" : unread}
                      </span>
                    )}
                  </button>
                  {singleChats.length > 1 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteChat(sc.id, sc.title || "Agent Chat");
                      }}
                      className="mr-2 rounded-lg p-1.5 text-gray-300 opacity-0 transition-all duration-150 group-hover:opacity-100 hover:bg-red-50 hover:text-red-500"
                      title="Delete chat"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Groups */}
        {groups.length > 0 && (
          <div className="mb-3">
            <h3 className="mb-1.5 flex items-center gap-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              <Users className="h-3 w-3" />
              Groups
            </h3>
            {groups.map((g) => {
              const isActive = activeConversationId === g.id;
              const unread = unreadCounts[g.id] ?? 0;
              const isTyping = typingConversations.has(g.id);
              return (
                <button
                  key={g.id}
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
                  className={`mb-0.5 flex w-full items-center rounded-xl px-3 py-2.5 text-left text-sm transition-all duration-150 ${
                    isActive
                      ? "bg-gradient-to-r from-indigo-50 to-blue-50 font-medium text-indigo-700 shadow-sm ring-1 ring-indigo-100"
                      : "text-gray-600 hover:bg-white hover:shadow-sm hover:ring-1 hover:ring-gray-100"
                  }`}
                >
                  <VendorChatIcon model={g.model} isActive={isActive} />
                  <div className="flex-1 min-w-0">
                    <span className="block truncate text-[13px]">{g.name}</span>
                    {isTyping && (
                      <span className="block text-[10px] font-medium text-emerald-500 animate-pulse-soft">
                        typing...
                      </span>
                    )}
                  </div>
                  {unread > 0 && (
                    <span className="ml-2 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 px-1.5 text-[10px] font-bold text-white shadow-sm">
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Empty state */}
        {groups.length === 0 && singleChats.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-100">
              <MessageCircle className="h-5 w-5 text-gray-300" />
            </div>
            <p className="text-xs text-gray-400">No conversations yet</p>
            <p className="text-[10px] text-gray-300 mt-0.5">
              Start a new chat above
            </p>
          </div>
        )}
      </nav>

      {/* Admin link */}
      {isAdmin && (
        <div className="px-3 py-1">
          <Link
            to="/admin"
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium text-gray-500 transition-all duration-150 hover:bg-white hover:text-gray-700 hover:shadow-sm"
          >
            <Settings className="h-4 w-4" />
            Admin Panel
          </Link>
        </div>
      )}

      {/* User Footer */}
      <div className="border-t border-gray-200/60 px-4 py-3 pb-5 sm:pb-3 safe-bottom">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-gray-200 to-gray-300 text-xs font-bold text-gray-600 shadow-sm">
              {(userName || "U").charAt(0).toUpperCase()}
            </div>
            <span className="text-[13px] font-medium text-gray-700 truncate max-w-[120px]">
              {userName || "User"}
            </span>
          </div>
          <button
            onClick={onLogout}
            className="rounded-xl p-2 text-gray-400 transition-all duration-150 hover:bg-red-50 hover:text-red-500"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
