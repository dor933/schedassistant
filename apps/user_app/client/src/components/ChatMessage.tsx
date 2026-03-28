import { User, AlertTriangle } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { VendorIcon } from "./VendorModelBadge";

const vendorAvatarColors: Record<string, string> = {
  openai: "bg-emerald-50 text-emerald-700 shadow-emerald-100/50 ring-emerald-200/60",
  anthropic: "bg-amber-50 text-amber-700 shadow-amber-100/50 ring-amber-200/60",
  google: "bg-blue-50 text-blue-700 shadow-blue-100/50 ring-blue-200/60",
};

const defaultAvatarColor = "bg-gray-100 text-gray-500 shadow-gray-100/50 ring-gray-200/60";

/** Highlight occurrences of `term` within `text`. */
function HighlightedText({ text, term }: { text: string; term: string }) {
  if (!term) return <>{text}</>;
  const lc = text.toLowerCase();
  const lcTerm = term.toLowerCase();
  const parts: { text: string; match: boolean }[] = [];
  let cursor = 0;
  let idx = lc.indexOf(lcTerm, cursor);
  while (idx !== -1) {
    if (idx > cursor) parts.push({ text: text.slice(cursor, idx), match: false });
    parts.push({ text: text.slice(idx, idx + term.length), match: true });
    cursor = idx + term.length;
    idx = lc.indexOf(lcTerm, cursor);
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return (
    <>
      {parts.map((p, i) =>
        p.match ? (
          <mark key={i} className="rounded-sm bg-amber-200/80 px-0.5 text-inherit">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  /** Display name shown above the bubble for group messages from other users. */
  senderName?: string;
  /** Vendor slug for the model (used to show vendor icon on assistant messages). */
  vendorSlug?: string | null;
  /** Display name of the model (e.g. "GPT-4o Mini"). */
  modelName?: string | null;
  /** Whether this message is in a group chat — enables sender labels. */
  isGroup?: boolean;
  /** Text to highlight within the message (search term). */
  highlightText?: string;
}

export default function ChatMessage({ role, content, senderName, vendorSlug, modelName, isGroup, highlightText }: ChatMessageProps) {
  const isUser = role === "user";
  const isError = !isUser && content.startsWith("Error:");
  // Messages from other group members: role is "user" but senderName is set
  const isOtherUser = isUser && !!senderName;
  // Current user's own message in a group chat
  const isSelfInGroup = isUser && !isOtherUser && isGroup;

  // When highlighting, render plain text with highlights instead of Markdown
  const renderContent = (className?: string) => {
    if (highlightText) {
      return (
        <div className={className}>
          <p className="whitespace-pre-wrap">
            <HighlightedText text={content} term={highlightText} />
          </p>
        </div>
      );
    }
    return (
      <div className={className}>
        <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
      </div>
    );
  };

  return (
    <div
      className={`flex animate-slide-up ${isUser && !isOtherUser ? "justify-end" : "justify-start"}`}
    >
      {/* Left-side avatar: assistant or other group member */}
      {!isUser && (
        <div className="mr-3 flex flex-col items-center gap-1 flex-shrink-0">
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-xl shadow-sm ring-1 ${
              isError
                ? "bg-red-100 text-red-500 ring-red-200/60"
                : vendorSlug
                  ? vendorAvatarColors[vendorSlug] ?? defaultAvatarColor
                  : defaultAvatarColor
            }`}
          >
            {isError ? (
              <AlertTriangle className="h-4 w-4" />
            ) : vendorSlug ? (
              <VendorIcon slug={vendorSlug} />
            ) : (
              <VendorIcon slug="" />
            )}
          </div>
          {modelName && !isError && (
            <span className="max-w-[4.5rem] truncate text-center text-[9px] font-medium leading-tight text-gray-400">
              {modelName}
            </span>
          )}
        </div>
      )}
      {isOtherUser && (
        <div className="mr-3 flex flex-col items-center gap-1 flex-shrink-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-blue-100 to-indigo-100 text-xs font-bold text-indigo-600 shadow-sm ring-1 ring-indigo-100">
            {senderName.charAt(0).toUpperCase()}
          </div>
        </div>
      )}

      {/* Bubble */}
      {isError ? (
        <div className="max-w-[88%] sm:max-w-[75%] rounded-2xl rounded-tl-md border border-red-200/60 bg-red-50 px-4 py-3 text-sm leading-relaxed text-red-800 shadow-sm">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-red-500">
            <AlertTriangle className="h-3.5 w-3.5" />
            Error
          </div>
          <p className="whitespace-pre-wrap">
            {content.replace(/^Error:\s*/, "")}
          </p>
        </div>
      ) : isOtherUser ? (
        <div className="max-w-[88%] sm:max-w-[75%]">
          <p className="mb-1 ml-1 text-[11px] font-semibold text-indigo-500">{senderName}</p>
          <div className="rounded-2xl rounded-tl-md bg-white px-4 py-3 text-sm text-gray-800 shadow-glass ring-1 ring-gray-950/[0.04]">
            {renderContent("chat-prose")}
          </div>
        </div>
      ) : (
        <div className="max-w-[88%] sm:max-w-[75%]">
          {isSelfInGroup && (
            <p className="mb-1 mr-1 text-right text-[11px] font-semibold text-gray-400">You</p>
          )}
          <div
            className={`text-sm ${
              isUser
                ? "rounded-2xl rounded-tr-md bg-gradient-to-br from-blue-600 to-indigo-600 px-4 py-3 text-white shadow-md shadow-blue-200/50"
                : "rounded-2xl rounded-tl-md bg-white px-4 py-3 text-gray-800 shadow-glass ring-1 ring-gray-950/[0.04]"
            }`}
          >
            {renderContent(`chat-prose ${isUser ? "chat-prose-user" : ""}`)}
          </div>
        </div>
      )}

      {/* Right-side avatar: current user's own messages */}
      {isUser && !isOtherUser && (
        <div className="ml-3 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-gray-100 to-gray-200 text-gray-500 shadow-sm ring-1 ring-gray-950/[0.04]">
          <User className="h-4 w-4" />
        </div>
      )}
    </div>
  );
}
