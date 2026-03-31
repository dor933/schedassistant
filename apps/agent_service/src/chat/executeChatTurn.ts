import type { CompiledStateGraph } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { HumanMessage } from "@langchain/core/messages";
import type { UserId } from "@scheduling-agent/types";
import { Thread } from "@scheduling-agent/database";
import { ensureSession } from "../sessionsManagment/sessionRegistry";
import { rotateThread } from "../sessionsManagment/threadRotation";
import { getLangfuseCallbackHandler, observeWithContext } from "../langfuse";
import { logger } from "../logger";
import { resolveModelSlug } from "./modelResolution";

/** Sanitize a display name for use as HumanMessage `name` (OpenAI rejects spaces and special chars). */
function sanitizeMsgName(raw: string): string {
  return raw.replace(/[\s<|\\/>]+/g, "_").replace(/^_+|_+$/g, "") || "user";
}

export type ChatTurnPayload = {
  userId: UserId;
  threadId: string;
  message: string;
  /** When set, scopes session registry + context summaries to this group. */
  groupId?: string | null;
  /** When set, scopes session registry + context summaries to this 1:1 chat. */
  singleChatId?: string | null;
  /** `agents.id` — loads `core_instructions` from the DB into the system prompt. */
  agentId?: string | null;
  /** Display name of the sender — stored on HumanMessage.name for group attribution. */
  displayName?: string;
};

export type ChatTurnResult = {
  threadId: string;
  reply: string;
  systemPrompt: string | null;
  modelSlug?: string;
  vendorSlug?: string;
  modelName?: string;
};

/**
 * Runs one LangGraph turn: session ensure, Langfuse observation, `graph.invoke` with callbacks.
 * Used by the BullMQ worker (and kept separate from HTTP for testability).
 */
export async function executeChatTurn(
  graph: CompiledStateGraph<any, any, any>,
  { userId, threadId, message, groupId, singleChatId, agentId, displayName }: ChatTurnPayload,
): Promise<ChatTurnResult> {
  const observationInput = {
    userId,
    threadId,
    messagePreview: typeof message === "string" ? message.substring(0, 500) : "",
  };

  return observeWithContext(
    "agent_chat_turn",
    async () => {
      // Resolve model slug from conversation scope
      const modelSlug = await resolveModelSlug(singleChatId, groupId);
      logger.info("Executing chat turn", { threadId, userId, agentId, modelSlug, msgLen: message.length });

      // Group + pool-agent single chats: shared thread — `threads.user_id` is null; scope lives on `groups` / `single_chats` / `agents`.
      const sessionUserId = groupId || singleChatId ? null : userId;
      await ensureSession(threadId, sessionUserId, {
        agentId: agentId ?? null,
      });

      // Snapshot summarizedAt before invoke so we can detect rotation trigger.
      const threadBefore = await Thread.findByPk(threadId, { attributes: ["summarizedAt"] });
      const preSummarizedAt = threadBefore?.summarizedAt?.getTime() ?? 0;

      const handler = getLangfuseCallbackHandler(userId, {
        threadId,
        service: "agent_service",
      });

      // Use HumanMessage with `name` so the LLM and history know who sent it.
      const senderName = sanitizeMsgName(
        displayName?.trim() ? displayName : String(userId),
      );
      const humanMsg = new HumanMessage({ content: message, name: senderName });

      const result = await graph.invoke(
        {
          userId,
          threadId,
          groupId: groupId ?? null,
          singleChatId: singleChatId ?? null,
          agentId: agentId ?? null,
          modelSlug,
          userInput: message,
          messages: [humanMsg],
        },
        {
          configurable: { thread_id: threadId },
          ...(handler
            ? {
                callbacks: [handler] as RunnableConfig["callbacks"],
              }
            : {}),
        } as RunnableConfig,
      );

      // If a node set an error (e.g. callModel API key missing / LLM failure), throw it
      // so the worker emits it as an error payload to the client.
      const graphError = (result as any).error;
      if (graphError) {
        throw new Error(typeof graphError === "string" ? graphError : JSON.stringify(graphError));
      }

      const messages: any[] = Array.isArray(result.messages) ? result.messages : [];
      const lastAiMessage = [...messages]
        .reverse()
        .find(
          (m: any) =>
            (typeof m._getType === "function" && m._getType() === "ai") ||
            m.role === "assistant",
        );

      logger.debug("Graph invoke done", { threadId, messageCount: messages.length, hasAiReply: !!lastAiMessage });

      // Detect summarization and rotate thread for next turn.
      // The current reply was already produced on this thread — rotation
      // only affects subsequent invocations.
      try {
        const threadAfter = await Thread.findByPk(threadId, { attributes: ["summarizedAt"] });
        const postSummarizedAt = threadAfter?.summarizedAt?.getTime() ?? 0;
        if (postSummarizedAt > preSummarizedAt) {
          logger.info("Summarization detected, rotating thread", { threadId, groupId, singleChatId });
          await rotateThread(groupId, singleChatId, agentId);
        }
      } catch (rotateErr: any) {
        // Rotation failure is non-fatal — the current thread stays active.
        logger.error("Thread rotation failed", { threadId, error: rotateErr?.message });
      }

      const reply =
        lastAiMessage?.content ??
        "Something went wrong — the model did not produce a response.";

      // Extract model metadata attached by callModelNode
      const ak = lastAiMessage?.additional_kwargs;
      const replyModelSlug: string | undefined = ak?.modelSlug;
      const replyVendorSlug: string | undefined = ak?.vendorSlug;
      const replyModelName: string | undefined = ak?.modelName;

      const sp = result.systemPrompt;
      return {
        threadId,
        reply: typeof reply === "string" ? reply : JSON.stringify(reply),
        systemPrompt:
          sp == null ? null : typeof sp === "string" ? sp : JSON.stringify(sp),
        ...(replyModelSlug ? { modelSlug: replyModelSlug } : {}),
        ...(replyVendorSlug ? { vendorSlug: replyVendorSlug } : {}),
        ...(replyModelName ? { modelName: replyModelName } : {}),
      };
    },
    observationInput,
  );
}

/**
 * Stores a human message in the LangGraph checkpoint without invoking the
 * agent graph. Used for group messages that don't @mention the agent.
 */
export async function storeMessageOnly(
  graph: CompiledStateGraph<any, any, any>,
  { userId, threadId, message, groupId, singleChatId, agentId, displayName }: ChatTurnPayload,
): Promise<void> {
  // Group threads are shared — don't tie them to a specific user.
  await ensureSession(threadId, groupId ? null : userId, {
    agentId: agentId ?? null,
  });

  const senderName = sanitizeMsgName(
    displayName?.trim() ? displayName : String(userId),
  );
  await graph.updateState(
    { configurable: { thread_id: threadId } },
    { messages: [new HumanMessage({ content: message, name: senderName })] },
  );

  logger.info("Message stored (no agent invocation)", { threadId, userId, msgLen: message.length });
}
