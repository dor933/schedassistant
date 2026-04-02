import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
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

function formatTimestamp(raw?: string): string | null {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    const now = new Date();
    const isToday =
      d.getDate() === now.getDate() &&
      d.getMonth() === now.getMonth() &&
      d.getFullYear() === now.getFullYear();
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (isToday) return time;
    return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
  } catch {
    return null;
  }
}

interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  senderName?: string;
  vendorSlug?: string | null;
  modelName?: string | null;
  isGroup?: boolean;
  highlightText?: string;
  createdAt?: string;
}

export default function ChatMessage({ role, content, senderName, vendorSlug, modelName, isGroup, highlightText, createdAt }: ChatMessageProps) {
  const isUser = role === "user";
  const isError = !isUser && content.startsWith("Error:");
  const isOtherUser = isUser && !!senderName;
  const isSelfInGroup = isUser && !isOtherUser && isGroup;
  const ts = formatTimestamp(createdAt);

  // התיקון כאן: הוספנו dir="auto" ויישור אדפטיבי (start) רק לטקסט
  const renderContent = (className?: string) => {
    if (highlightText) {
      return (
        <Box 
          dir="auto" 
          className={className} 
          sx={{ overflowWrap: "break-word", wordBreak: "break-word", minWidth: 0, textAlign: "start" }}
        >
          <p className="whitespace-pre-wrap">
            <HighlightedText text={content} term={highlightText} />
          </p>
        </Box>
      );
    }
    return (
      <Box 
        dir="auto" 
        className={className} 
        sx={{ overflowWrap: "break-word", wordBreak: "break-word", minWidth: 0, textAlign: "start" }}
      >
        <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
      </Box>
    );
  };

  return (
    <Stack
      direction="row"
      className="animate-slide-up"
      // הערה: הורדנו מפה את ה dir="auto" כדי לא להפוך את כיוון ה-UI כולו!
      sx={{
        justifyContent: isUser && !isOtherUser ? "flex-end" : "flex-start",
      }}
    >
      {/* Left-side avatar: assistant or other group member */}
      {!isUser && (
        <Stack
          alignItems="center"
          spacing={0.5}
          sx={{ mr: 1.5, flexShrink: 0 }}
        >
          <Box
            className={`flex h-8 w-8 items-center justify-center rounded-xl shadow-sm ring-1 ${isError
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
          </Box>
          {modelName && !isError && (
            <Box
              component="span"
              className="text-center font-medium text-gray-400"
              sx={{
                maxWidth: "4.5rem",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: "9px",
                lineHeight: "tight",
              }}
            >
              {modelName}
            </Box>
          )}
        </Stack>
      )}
      {isOtherUser && (
        <Stack
          alignItems="center"
          spacing={0.5}
          sx={{ mr: 1.5, flexShrink: 0 }}
        >
          <Box className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-blue-100 to-indigo-100 text-xs font-bold text-indigo-600 shadow-sm ring-1 ring-indigo-100">
            {senderName.charAt(0).toUpperCase()}
          </Box>
        </Stack>
      )}

      {/* Bubble */}
      {isError ? (
        <Box sx={{ maxWidth: { xs: "88%", sm: "75%" }, minWidth: 0 }}>
          <Box
            className="rounded-2xl rounded-tl-md border border-red-200/60 bg-red-50 shadow-sm"
            sx={{
              px: 2,
              py: 1.5,
              fontSize: "0.875rem",
              lineHeight: "1.625",
              color: "rgb(153 27 27)",
              minWidth: 0,
              overflow: "hidden",
            }}
          >
            <Stack
              direction="row"
              alignItems="center"
              spacing={0.75}
              sx={{ mb: 0.75, fontSize: "0.75rem", fontWeight: 600, color: "rgb(239 68 68)" }}
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>Error</span>
            </Stack>
            <Box
              component="p"
              dir="auto"
              sx={{
                whiteSpace: "pre-wrap",
                overflowWrap: "break-word",
                wordBreak: "break-word",
                minWidth: 0,
                textAlign: "start"
              }}
            >
              {content.replace(/^Error:\s*/, "")}
            </Box>
          </Box>
          {ts && <Box className="mt-1 ml-1 text-[10px] text-gray-400" sx={{ userSelect: "none" }}>{ts}</Box>}
        </Box>
      ) : isOtherUser ? (
        <Box sx={{ maxWidth: { xs: "88%", sm: "75%" }, minWidth: 0 }}>
          <Box component="p" className="mb-1 ml-1 text-[11px] font-semibold text-indigo-500">{senderName}</Box>
          <Box className="rounded-2xl rounded-tl-md bg-white px-4 py-3 text-sm text-gray-800 shadow-glass ring-1 ring-gray-950/[0.04]" sx={{ minWidth: 0, overflow: "hidden" }}>
            {renderContent("chat-prose")}
          </Box>
          {ts && <Box className="mt-1 ml-1 text-[10px] text-gray-400" sx={{ userSelect: "none" }}>{ts}</Box>}
        </Box>
      ) : (
        <Box sx={{ maxWidth: { xs: "88%", sm: "75%" }, minWidth: 0 }}>
          {isSelfInGroup && (
            <Box component="p" className="mb-1 mr-1 text-right text-[11px] font-semibold text-gray-400">You</Box>
          )}
          <Box
            className={`text-sm ${isUser
              ? "rounded-2xl rounded-tr-md bg-gradient-to-br from-blue-600 to-indigo-600 px-4 py-3 text-white shadow-md shadow-blue-200/50"
              : "rounded-2xl rounded-tl-md bg-white px-4 py-3 text-gray-800 shadow-glass ring-1 ring-gray-950/[0.04]"
              }`}
            sx={{ minWidth: 0, overflow: "hidden" }}
          >
            {renderContent(`chat-prose ${isUser ? "chat-prose-user" : ""}`)}
          </Box>
          {ts && (
            <Box
              className={`mt-1 text-[10px] text-gray-400 ${isUser ? "mr-1 text-right" : "ml-1"}`}
              sx={{ userSelect: "none" }}
            >
              {ts}
            </Box>
          )}
        </Box>
      )}

      {/* Right-side avatar: current user's own messages */}
      {isUser && !isOtherUser && (
        <Box className="ml-3 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-gray-100 to-gray-200 text-gray-500 shadow-sm ring-1 ring-gray-950/[0.04]">
          <User className="h-4 w-4" />
        </Box>
      )}
    </Stack>
  );
}