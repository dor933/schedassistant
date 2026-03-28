import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type FormEvent,
  type KeyboardEvent,
  type ChangeEvent,
} from "react";
import { SendHorizonal, X } from "lucide-react";
import { VendorIcon, vendorColors } from "./VendorModelBadge";

interface ChatInputProps {
  onSend: (message: string) => void;
  onTyping?: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** Agent definition name — enables @mention autocomplete in group chats. */
  agentName?: string;
  /** Vendor slug for the agent badge icon/colors. */
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

  // Close dropdown on outside click
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

    // Prepend @AgentName if mentioned
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
    // Close dropdown on Escape
    if (e.key === "Escape" && showMentionDropdown) {
      setShowMentionDropdown(false);
    }
  }

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setText(val);

    // Detect @ for mention autocomplete
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
        // If user keeps typing after @, check if it still partially matches
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
    // Remove the @... partial text that triggered the dropdown
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

  const chipColors = vendorSlug && vendorColors[vendorSlug]
    ? vendorColors[vendorSlug]
    : "bg-indigo-50 text-indigo-700 border-indigo-200/60";

  return (
    <div className="border-t border-gray-100 bg-white/80 backdrop-blur-xl px-4 py-3 pb-5 sm:pb-3 sm:px-6 sm:py-3 safe-bottom">
      <form
        onSubmit={handleSubmit}
        className="mx-auto flex max-w-3xl items-end gap-3"
      >
        <div className="relative flex-1">
          {/* Mention autocomplete dropdown */}
          {showMentionDropdown && agentName && (
            <div
              ref={dropdownRef}
              className="absolute bottom-full left-0 mb-2 w-full max-w-xs animate-scale-in rounded-xl border border-gray-200/80 bg-white shadow-glass-lg backdrop-blur-xl overflow-hidden z-10"
            >
              <button
                type="button"
                onClick={handleSelectMention}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors hover:bg-indigo-50/70 active:bg-indigo-100/50"
              >
                <div
                  className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg shadow-sm ring-1 ${
                    vendorSlug === "openai" ? "bg-emerald-50 text-emerald-700 ring-emerald-200/60" :
                    vendorSlug === "anthropic" ? "bg-amber-50 text-amber-700 ring-amber-200/60" :
                    vendorSlug === "google" ? "bg-blue-50 text-blue-700 ring-blue-200/60" :
                    "bg-indigo-50 text-indigo-600 ring-indigo-200/60"
                  }`}
                >
                  <VendorIcon slug={vendorSlug ?? ""} />
                </div>
                <span className="font-medium text-gray-900">{agentName}</span>
                {vendorSlug && (
                  <span className={`ml-auto inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${chipColors}`}>
                    <VendorIcon slug={vendorSlug} />
                  </span>
                )}
              </button>
            </div>
          )}

          {/* Input area with optional chip */}
          <div
            className={`rounded-2xl border bg-gray-50/80 shadow-sm transition-all duration-200 ${
              focused
                ? "border-indigo-300 bg-white ring-4 ring-indigo-500/10"
                : "border-gray-200"
            } ${disabled ? "opacity-50" : ""}`}
          >
            {/* Mention chip */}
            {mentionedAgent && agentName && (
              <div className="px-3 pt-2.5 pb-0">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold shadow-sm ${chipColors}`}
                >
                  <VendorIcon slug={vendorSlug ?? ""} />
                  <span>@{agentName}</span>
                  <button
                    type="button"
                    onClick={handleRemoveMention}
                    className="ml-0.5 rounded-full p-0.5 transition-colors hover:bg-black/10"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              </div>
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
              className="w-full resize-none bg-transparent px-4 py-3 text-sm placeholder-gray-400 focus:outline-none disabled:opacity-50"
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={disabled || !hasContent}
          className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl shadow-sm transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-indigo-500/20 ${
            hasContent && !disabled
              ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:shadow-md hover:shadow-indigo-200/50 active:scale-95"
              : "bg-gray-100 text-gray-300 cursor-not-allowed"
          }`}
        >
          <SendHorizonal className="h-[18px] w-[18px]" />
        </button>
      </form>
    </div>
  );
}
