import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type FormEvent,
  type KeyboardEvent,
  type ChangeEvent,
} from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import { Paperclip, SendHorizonal, X } from "lucide-react";
import { VendorIcon } from "./VendorModelBadge";

interface ChatInputProps {
  onSend: (message: string, attachment?: File) => void;
  onTyping?: () => void;
  disabled?: boolean;
  placeholder?: string;
  agentName?: string;
  vendorSlug?: string;
}

/** Mirrors the server-side multer limit (2 MB). */
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const ACCEPTED_EXT = [".md", ".txt"];
const ACCEPT_ATTRIBUTE = ACCEPTED_EXT.join(",");

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function ChatInput({
  onSend,
  onTyping,
  disabled,
  placeholder,
  agentName,
  vendorSlug,
}: ChatInputProps) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [mentionedAgent, setMentionedAgent] = useState(false);
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 150)}px`;
    }
  }, [text]);

  useEffect(() => {
    if (!showMentionDropdown) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowMentionDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showMentionDropdown]);

  const handleTyping = useCallback(() => {
    if (!onTyping) return;
    if (typingTimer.current) return;
    onTyping();
    typingTimer.current = setTimeout(() => {
      typingTimer.current = null;
    }, 2000);
  }, [onTyping]);

  function handleSubmit(e?: FormEvent) {
    e?.preventDefault();
    const trimmed = text.trim();
    if (!trimmed && !mentionedAgent && !attachment) return;
    if (disabled) return;

    const finalText = mentionedAgent && agentName
      ? `@${agentName} ${trimmed}`
      : trimmed;

    // When only a file is sent (no typed text), server still accepts.
    if (!finalText && !attachment) return;

    onSend(finalText, attachment ?? undefined);
    setText("");
    setMentionedAgent(false);
    setAttachment(null);
    setAttachmentError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleFilePick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachmentError(null);

    const name = file.name.toLowerCase();
    const extOk = ACCEPTED_EXT.some((ext) => name.endsWith(ext));
    if (!extOk) {
      setAttachmentError(`Only ${ACCEPTED_EXT.join(", ")} files are supported.`);
      e.target.value = "";
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setAttachmentError("File exceeds 2 MB limit.");
      e.target.value = "";
      return;
    }
    setAttachment(file);
  }

  function handleRemoveAttachment() {
    setAttachment(null);
    setAttachmentError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === "Escape" && showMentionDropdown) {
      setShowMentionDropdown(false);
    }
  }

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setText(val);

    if (agentName && !mentionedAgent) {
      const cursorPos = e.target.selectionStart ?? val.length;
      const charAtCursor = val[cursorPos - 1];
      const charBefore = cursorPos > 1 ? val[cursorPos - 2] : undefined;

      if (
        charAtCursor === "@" &&
        (!charBefore || charBefore === " " || charBefore === "\n")
      ) {
        setShowMentionDropdown(true);
      } else if (showMentionDropdown) {
        const lastAtIndex = val.lastIndexOf("@");
        if (lastAtIndex >= 0) {
          const typed = val.slice(lastAtIndex + 1).toLowerCase();
          if (!agentName.toLowerCase().startsWith(typed)) {
            setShowMentionDropdown(false);
          }
        } else {
          setShowMentionDropdown(false);
        }
      }
    }

    if (val.trim()) handleTyping();
  }

  function handleSelectMention() {
    const lastAtIndex = text.lastIndexOf("@");
    if (lastAtIndex >= 0) {
      const spaceAfter = text.indexOf(" ", lastAtIndex);
      const before = text.slice(0, lastAtIndex);
      const after = spaceAfter === -1 ? "" : text.slice(spaceAfter);
      setText((before + after).trim() === "" ? "" : before + after);
    }
    setMentionedAgent(true);
    setShowMentionDropdown(false);
    textareaRef.current?.focus();
  }

  function handleRemoveMention() {
    setMentionedAgent(false);
    textareaRef.current?.focus();
  }

  const hasContent =
    text.trim().length > 0 || mentionedAgent || attachment !== null;

  const chipColorsDark = (() => {
    switch (vendorSlug) {
      case "openai":
        return "border-emerald-400/30 bg-emerald-500/15 text-emerald-200";
      case "anthropic":
        return "border-amber-400/30 bg-amber-500/15 text-amber-200";
      case "google":
        return "border-sky-400/30 bg-sky-500/15 text-sky-200";
      default:
        return "border-indigo-400/30 bg-indigo-500/15 text-indigo-200";
    }
  })();

  return (
    <Box
      className="border-t border-white/5 bg-slate-950/40 backdrop-blur-xl safe-bottom"
      sx={{
        px: { xs: 2, sm: 3 },
        py: { xs: 1.5, sm: 1.5 },
        pb: { xs: 2.5, sm: 1.5 },
      }}
    >
      <Stack
        component="form"
        direction="row"
        alignItems="flex-end"
        spacing={1.5}
        onSubmit={handleSubmit}
        sx={{ mx: "auto", maxWidth: "48rem" }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          onChange={handleFilePick}
          style={{ display: "none" }}
        />
        <Box
          component="button"
          type="button"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
          title="Attach a .md or .txt file (max 2 MB)"
          className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-indigo-200/70 transition-all duration-200 hover:bg-white/[0.08] hover:border-white/20 hover:text-indigo-100 focus:outline-none focus:ring-4 focus:ring-indigo-400/30 ${
            disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
          }`}
        >
          <Paperclip className="h-[18px] w-[18px]" />
        </Box>
        <Box sx={{ position: "relative", flex: 1, minWidth: 0 }}>
          {/* Mention autocomplete dropdown */}
          {showMentionDropdown && agentName && (
            <Box
              ref={dropdownRef}
              className="animate-scale-in glass-panel-elevated overflow-hidden"
              sx={{
                position: "absolute",
                bottom: "100%",
                left: 0,
                mb: 1,
                width: "100%",
                maxWidth: "20rem",
                zIndex: 10,
                borderRadius: "0.75rem",
              }}
            >
              <Stack
                component="button"
                type="button"
                direction="row"
                alignItems="center"
                spacing={1.25}
                onClick={handleSelectMention}
                className="w-full text-left text-sm transition-colors hover:bg-white/[0.06] active:bg-white/[0.1]"
                sx={{ px: 1.5, py: 1.25, cursor: "pointer" }}
              >
                <Box
                  className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg backdrop-blur-sm ring-1 ${
                    vendorSlug === "openai" ? "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30" :
                    vendorSlug === "anthropic" ? "bg-amber-500/15 text-amber-300 ring-amber-400/30" :
                    vendorSlug === "google" ? "bg-sky-500/15 text-sky-300 ring-sky-400/30" :
                    "bg-indigo-500/15 text-indigo-300 ring-indigo-400/30"
                  }`}
                >
                  <VendorIcon slug={vendorSlug ?? ""} />
                </Box>
                <Box component="span" className="font-medium text-white">{agentName}</Box>
                {vendorSlug && (
                  <Box
                    component="span"
                    className={`ml-auto inline-flex items-center gap-1 rounded-full border text-[10px] font-semibold ${chipColorsDark}`}
                    sx={{ px: 1, py: 0.25 }}
                  >
                    <VendorIcon slug={vendorSlug} />
                  </Box>
                )}
              </Stack>
            </Box>
          )}

          {/* Input area with optional chip */}
          <Box
            className={`rounded-2xl border backdrop-blur-xl transition-all duration-200 ${
              focused
                ? "border-indigo-400/50 bg-white/[0.08] shadow-[0_0_32px_-8px_rgba(129,140,248,0.55)]"
                : "border-white/10 bg-white/[0.04] hover:border-white/15"
            } ${disabled ? "opacity-50" : ""}`}
          >
            {/* Mention chip */}
            {mentionedAgent && agentName && (
              <Box sx={{ px: 1.5, pt: 1.25, pb: 0 }}>
                <Stack
                  direction="row"
                  alignItems="center"
                  className={`rounded-full border text-xs font-semibold backdrop-blur-sm ${chipColorsDark}`}
                  sx={{ display: "inline-flex", width: "auto", gap: "6px", pl: "10px", pr: "6px", py: "4px" }}
                >
                  <Box sx={{ display: "flex", flexShrink: 0 }}>
                    <VendorIcon slug={vendorSlug ?? ""} />
                  </Box>
                  <Box component="span" sx={{ whiteSpace: "nowrap" }}>@{agentName}</Box>
                  <Box
                    component="button"
                    type="button"
                    onClick={handleRemoveMention}
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      borderRadius: "50%",
                      p: "2px",
                      cursor: "pointer",
                      transition: "background-color 150ms",
                      "&:hover": { bgcolor: "rgba(255,255,255,0.15)" },
                    }}
                  >
                    <X className="h-3 w-3" />
                  </Box>
                </Stack>
              </Box>
            )}

            {attachment && (
              <Box sx={{ px: 1.5, pt: 1.25, pb: 0 }}>
                <Stack
                  direction="row"
                  alignItems="center"
                  className="rounded-full border border-indigo-400/30 bg-indigo-500/10 text-xs font-medium text-indigo-100 backdrop-blur-sm"
                  sx={{
                    display: "inline-flex",
                    width: "auto",
                    maxWidth: "100%",
                    gap: "6px",
                    pl: "10px",
                    pr: "6px",
                    py: "4px",
                    minWidth: 0,
                  }}
                >
                  <Paperclip className="h-3.5 w-3.5 flex-shrink-0 text-indigo-300" />
                  <Box
                    component="span"
                    sx={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                    }}
                  >
                    {attachment.name}
                  </Box>
                  <Box
                    component="span"
                    className="text-indigo-200/60"
                    sx={{ whiteSpace: "nowrap", flexShrink: 0 }}
                  >
                    {formatBytes(attachment.size)}
                  </Box>
                  <Box
                    component="button"
                    type="button"
                    onClick={handleRemoveAttachment}
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      borderRadius: "50%",
                      p: "2px",
                      cursor: "pointer",
                      transition: "background-color 150ms",
                      "&:hover": { bgcolor: "rgba(255,255,255,0.15)" },
                    }}
                  >
                    <X className="h-3 w-3" />
                  </Box>
                </Stack>
              </Box>
            )}
            {attachmentError && (
              <Box sx={{ px: 1.5, pt: 1.25, pb: 0 }}>
                <Box
                  component="span"
                  className="text-xs font-medium text-rose-300"
                >
                  {attachmentError}
                </Box>
              </Box>
            )}

            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={placeholder ?? "Type a message..."}
              rows={1}
              disabled={disabled}
              className="w-full resize-none bg-transparent px-4 py-3 text-sm text-white placeholder-indigo-200/40 focus:outline-none disabled:opacity-50"
            />
          </Box>
        </Box>
        <Box
          component="button"
          type="submit"
          disabled={disabled || !hasContent}
          className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-indigo-400/30 ${
            hasContent && !disabled
              ? "bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 text-white shadow-[0_0_24px_-4px_rgba(168,85,247,0.65)] hover:shadow-[0_0_32px_-4px_rgba(168,85,247,0.85)] hover:brightness-110 active:scale-95"
              : "bg-white/[0.04] border border-white/10 text-indigo-200/30 cursor-not-allowed"
          }`}
        >
          <SendHorizonal className="h-[18px] w-[18px]" />
        </Box>
      </Stack>
    </Box>
  );
}
