import { ConversationMessage } from "@scheduling-agent/database";

const RECENT_MESSAGE_LIMIT = 50;

export type ConversationLogForContext = {
  /** Non-empty when there are rows to show (intro + formatted lines). */
  body: string;
  messageCount: number;
};

/**
 * Loads the most recent messages from `conversation_messages` for the active
 * conversation scope (single chat or group). Used to ground the model in the
 * durable transcript for **this** user/group, distinct from thread state and summaries.
 */
export async function loadRecentConversationMessagesForContext(
  singleChatId: string | null,
  groupId: string | null,
  options?: { limit?: number },
): Promise<ConversationLogForContext> {
  if (!singleChatId && !groupId) {
    return { body: "", messageCount: 0 };
  }

  const where = singleChatId
    ? { singleChatId }
    : { groupId: groupId! };

  const rows = await ConversationMessage.findAll({
    where,
    order: [["createdAt", "DESC"]],
    limit: options?.limit ?? RECENT_MESSAGE_LIMIT,
  });

  const chronological = [...rows].reverse();
  if (chronological.length === 0) {
    return { body: "", messageCount: 0 };
  }

  const scopeExplanation = singleChatId
    ? "This is the **durable database transcript** for **this** one-on-one chat only (`conversation_messages` for this `single_chat_id`). " +
      "It includes every persisted turn for **this user’s chat**, regardless of LangGraph thread rotation. " +
      "It may list different or more messages than the **LangGraph checkpoint** section above: that section reflects **shared thread state** (possibly including other users on a pool agent), while **this** block is **only** this conversation scope."
    : "This is the **durable database transcript** for **this group** (`conversation_messages` for this `group_id`). " +
      "It is scoped to this group only. The **LangGraph checkpoint** section above reflects thread state, which may differ in length or ordering after summarization.";

  const distinction =
    " This block is also **different from** **session summaries** and **episodic memory** elsewhere in this prompt: those are agent-level or cross-thread; this block is the authoritative per-conversation log.";

  const intro = `${scopeExplanation}${distinction}\n`;

  const lines = chronological.map((r) => {
    const ts =
      r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt);
    const safe = (r.content ?? "").replace(/\s+/g, " ").trim();
    if (r.role === "user") {
      const who = r.senderName?.trim() || "User";
      return `- [${ts}] **${who}** (user): ${safe}`;
    }
    return `- [${ts}] **Assistant**: ${safe}`;
  });

  return {
    body: `${intro}\n${lines.join("\n")}`,
    messageCount: chronological.length,
  };
}
