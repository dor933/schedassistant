import type { CompiledStateGraph } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { HumanMessage } from "@langchain/core/messages";
import { ensureSession } from "../memory/sessionRegistry";
import { getLangfuseCallbackHandler, observeWithContext } from "../langfuse";
import { logger } from "../logger";
import { resolveModelSlug } from "./modelResolution";

export type ChatTurnPayload = {
  userId: string;
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
    "scheduling_agent_chat",
    async () => {
      // Resolve model slug from conversation scope
      const modelSlug = await resolveModelSlug(singleChatId, groupId);
      logger.info("Executing chat turn", { threadId, userId, agentId, modelSlug, msgLen: message.length });

      // Group threads are shared — don't tie them to a specific user.
      await ensureSession(threadId, groupId ? null : userId, {
        groupId: groupId ?? null,
        singleChatId: singleChatId ?? null,
        agentId: agentId ?? null,
      });

      const handler = getLangfuseCallbackHandler(userId, {
        threadId,
        service: "agent_service",
      });

      // Use HumanMessage with `name` so the LLM and history know who sent it.
      const senderName = displayName || userId;
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

      const reply =
        lastAiMessage?.content ??
        "Something went wrong — the model did not produce a response.";

      const sp = result.systemPrompt;
      return {
        threadId,
        reply: typeof reply === "string" ? reply : JSON.stringify(reply),
        systemPrompt:
          sp == null ? null : typeof sp === "string" ? sp : JSON.stringify(sp),
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
    groupId: groupId ?? null,
    singleChatId: singleChatId ?? null,
    agentId: agentId ?? null,
  });

  const senderName = displayName || userId;
  await graph.updateState(
    { configurable: { thread_id: threadId } },
    { messages: [new HumanMessage({ content: message, name: senderName })] },
  );

  logger.info("Message stored (no agent invocation)", { threadId, userId, msgLen: message.length });
}
