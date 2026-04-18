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
import { SendHorizonal, X } from "lucide-react";
import { VendorIcon } from "./VendorModelBadge";

interface ChatInputProps {
  onSend: (message: string) => void;
  onTyping?: () => void;
  disabled?: boolean;
  placeholder?: string;
  agentName?: string;
  vendorSlug?: string;
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
    if (!trimmed && !mentionedAgent) return;
    if (disabled) return;

    const finalText = mentionedAgent && agentName
      ? `@${agentName} ${trimmed}`
      : trimmed;

    if (!finalText.trim()) return;
    onSend(finalText);
    setText("");
    setMentionedAgent(false);
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

  const hasContent = text.trim().length > 0 || mentionedAgent;

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
