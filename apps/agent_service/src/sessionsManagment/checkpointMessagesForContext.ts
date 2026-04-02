import type { BaseMessage } from "@langchain/core/messages";
import {
  HumanMessage,
  isAIMessage,
  isHumanMessage,
  isToolMessage,
} from "@langchain/core/messages";

const MAX_MESSAGES = 50;
const MAX_CHARS_PER_MESSAGE = 4000;

export type CheckpointMessagesForContext = {
  body: string;
  messageCount: number;
};

function textFromContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (part && typeof part === "object" && "text" in part && typeof (part as { text?: string }).text === "string") {
        parts.push((part as { text: string }).text);
      }
    }
    return parts.join("\n");
  }
  return String(content);
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= MAX_CHARS_PER_MESSAGE) return t;
  return `${t.slice(0, MAX_CHARS_PER_MESSAGE)}…`;
}

/**
 * Formats LangGraph checkpoint `messages` for the **system prompt** so the model
 * sees an explicit snapshot of thread state (including other users on a shared pool thread),
 * alongside the separate `conversation_messages` block.
 *
 * The same messages are still sent as chat history after the system message in `callModel`;
 * this block documents that and gives a readable transcript inside the system string.
 */
export function formatCheckpointMessagesForSystemPrompt(
  messages: BaseMessage[] | undefined,
  opts: { singleChatId: string | null; groupId: string | null },
): CheckpointMessagesForContext {
  const list = messages ?? [];
  if (list.length === 0) {
    const emptyBody =
      "## LangGraph thread (checkpoint state)\n\n" +
      "*(No messages in the LangGraph checkpoint for this thread yet — this may be the first turn.)*\n\n" +
      "When turns exist, they are also supplied as **chat messages after this system message**.\n";
    return { body: emptyBody, messageCount: 0 };
  }

  const slice = list.length > MAX_MESSAGES ? list.slice(-MAX_MESSAGES) : list;

  const sharedPoolNote =
    opts.singleChatId && !opts.groupId
      ? "For **pool agents**, one LangGraph thread is **shared** across all users; this snapshot may include **other users’** turns (see sender labels). "
      : opts.groupId
        ? "This is the **group** thread checkpoint; human messages may name different senders. "
        : "";

  const dualChannel =
    "**Important:** The same checkpoint messages are also passed to you as **normal chat messages immediately after this system message** (HumanMessage / AIMessage / ToolMessage). " +
    "Use **both** this section and that history consistently; they describe the same underlying thread state.\n\n";

  const intro =
    "## LangGraph thread (checkpoint state)\n\n" +
    "This block is a **snapshot of messages stored in the LangGraph checkpoint** for this `thread_id`. " +
    sharedPoolNote +
    "After summarization or thread rotation, this window may be shorter than the full past; durable history for **this** chat (or group) is in **Recent messages (durable conversation log)** below.\n\n" +
    dualChannel;

  const lines: string[] = [];
  for (const m of slice) {
    // Messages from the checkpoint may be deserialized plain objects (no _getType).
    // Use LangChain type checks first, fall back to raw `.role` / `._type` fields.
    const raw = m as any;
    const msgType: string | undefined =
      typeof raw._getType === "function"
        ? raw._getType()
        : raw._type ?? raw.role ?? undefined;

    const isHuman = msgType === "human" || msgType === "user" || (typeof raw._getType === "function" && isHumanMessage(m));
    const isAI = !isHuman && (msgType === "ai" || msgType === "assistant" || (typeof raw._getType === "function" && isAIMessage(m)));
    const isTool = !isHuman && !isAI && (msgType === "tool" || (typeof raw._getType === "function" && isToolMessage(m)));

    if (isHuman) {
      const name =
        raw.name?.trim() ||
        raw.additional_kwargs?.name?.trim() ||
        "User";
      lines.push(`- **${name}** (human): ${clip(textFromContent(raw.content))}`);
    } else if (isAI) {
      lines.push(`- **Assistant**: ${clip(textFromContent(raw.content))}`);
    } else if (isTool) {
      lines.push(`- *(tool result)*: ${clip(textFromContent(raw.content))}`);
    } else {
      lines.push(`- *(message)*: ${clip(textFromContent(raw.content ?? ""))}`);
    }
  }

  return {
    body: `${intro}${lines.join("\n")}`,
    messageCount: slice.length,
  };
}
