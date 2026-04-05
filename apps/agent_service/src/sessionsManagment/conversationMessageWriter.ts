import { ConversationMessage } from "@scheduling-agent/database";
import { logger } from "../logger";

/**
 * Appends a single row to `conversation_messages` — the durable per-chat
 * transcript. Called from the worker (inside the per-chat lock) for both
 * user and assistant messages.
 */
export async function writeConversationMessage(params: {
  singleChatId: string;
  role: "user" | "assistant";
  content: string;
  senderName?: string | null;
  requestId?: string | null;
  modelSlug?: string | null;
  vendorSlug?: string | null;
  modelName?: string | null;
}): Promise<void> {
  try {
    await ConversationMessage.create({
      singleChatId: params.singleChatId,
      role: params.role,
      content: params.content,
      senderName: params.senderName ?? null,
      requestId: params.requestId ?? null,
      modelSlug: params.modelSlug ?? null,
      vendorSlug: params.vendorSlug ?? null,
      modelName: params.modelName ?? null,
    });
  } catch (err: any) {
    // Log but don't throw — the socket reply has already happened (or will),
    // and this table is secondary to the LangGraph checkpoint.
    logger.error("Failed to write conversation message", {
      singleChatId: params.singleChatId,
      role: params.role,
      error: err?.message,
    });
  }
}
