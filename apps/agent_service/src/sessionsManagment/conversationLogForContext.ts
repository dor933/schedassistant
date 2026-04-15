import { ConversationMessage } from "@scheduling-agent/database";

const RECENT_MESSAGE_LIMIT = 30;

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
    ? "## This conversation (durable transcript)\n\n" +
      "This is the complete message history for **this specific chat only** — scoped to this user. " +
      "Unlike the shared thread above (which spans all your conversations), this block is **only** what happened in this conversation. " +
      "**This is the primary context you are responding to right now.**\n\n" +
      "If messages appear in both sections, that’s expected — the shared thread captured them as part of your overall activity, " +
      "and this section shows them in their conversation-specific context."
    : "## This conversation (durable transcript)\n\n" +
      "This is the complete message history for **this group** — scoped to this group only. " +
      "Unlike the shared thread above (which spans all your conversations), this block is **only** this group’s discussion. " +
      "**This is the primary context you are responding to right now.**\n\n" +
      "If messages appear in both sections, that’s expected — the shared thread captured them as part of your overall activity, " +
      "and this section shows them in their conversation-specific context.";

  const intro = `${scopeExplanation}\n`;

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
