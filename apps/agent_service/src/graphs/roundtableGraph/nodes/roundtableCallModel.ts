import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogle } from "@langchain/google";
import { ChatAnthropic } from "@langchain/anthropic";
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
  isAIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { LLMModel, Vendor } from "@scheduling-agent/database";
import { resolveModelSlug } from "../../../chat/modelResolution";
import { AgentState } from "../../../state";
import { logger } from "../../../logger";

import { EditUserIdentityTool } from "../../../tools/editUserIdentityTool";
import { EditAgentNameTool } from "../../../tools/agentNameTool";
import { ConsultAgentTool } from "../../../tools/consultAgentTool";
import { ListSystemAgentsTool } from "../../../tools/listSystemAgentsTool";
import { ListAgentsTool } from "../../../tools/listAgentsTool";
import { SyncDelegateToDeepAgentTool } from "../../../tools/syncDelegateToDeepAgentTool";
import { ReadAgentNotesTool, AppendAgentNotesTool, EditAgentNotesTool } from "../../../tools/agentNotesTool";
import { workspaceTools } from "../../../tools/workspaceTools";
import { agentSkillTools } from "../../../tools/skillsTools";
import { SaveEpisodicMemoryTool, RecallEpisodicMemoryTool } from "../../../tools/episodicMemoryTool";
import { ListProjectsTool, ListRepositoriesTool } from "../../../tools/epicTaskTools";
import { QueryDatabaseTool } from "../../../tools/queryDatabaseTool";
import getMcpTools from "../../../mcpClient";

const MAX_TOOL_ROUNDS = 15;

// ─── Vendor / model helpers (same as basicGraph/callModel) ───────────────────

async function resolveVendor(
  modelSlug: string,
): Promise<{ slug: string; apiKey: string | null; modelName: string } | null> {
  const model = await LLMModel.findOne({
    where: { slug: modelSlug },
    attributes: ["id", "name", "vendorId"],
  });
  if (!model) return null;
  const vendor = await Vendor.findByPk(model.vendorId, {
    attributes: ["slug", "apiKey"],
  });
  if (!vendor) return null;
  return { slug: vendor.slug, apiKey: vendor.apiKey ?? null, modelName: model.name };
}

function getModel(
  modelSlug: string,
  vendorSlug: string,
  apiKey: string,
): BaseChatModel {
  switch (vendorSlug) {
    case "openai":
      return new ChatOpenAI({ modelName: modelSlug, temperature: 0.4, apiKey });
    case "anthropic":
      return new ChatAnthropic({
        modelName: modelSlug,
        temperature: 0.4,
        apiKey,
        ...(process.env.MERIDIAN_URL
          ? { anthropicApiUrl: process.env.MERIDIAN_URL }
          : {}),
      });
    case "google":
      return new ChatGoogle({ model: modelSlug, temperature: 0.4, apiKey });
    default:
      throw new Error(
        `Unsupported vendor "${vendorSlug}" for model "${modelSlug}"`,
      );
  }
}

// ─── Message normalisation helpers ───────────────────────────────────────────

function sanitizeName(raw: string): string {
  return raw.replace(/[\s<|\\/>]+/g, "_").replace(/^_+|_+$/g, "") || "user";
}

function stripThinkingSignatures(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (
      part &&
      typeof part === "object" &&
      (part as Record<string, unknown>).type === "thinking"
    ) {
      const { signature, ...rest } = part as Record<string, unknown>;
      return rest;
    }
    return part;
  });
}

function normalizeAssistantContentForOpenAI(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      out.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const typ = p.type;
    if (typ === "functionCall" || typ === "function_call") continue;
    if (typ === "text" && typeof p.text === "string") out.push(p.text);
    if (typ === "refusal" && typeof p.refusal === "string") out.push(p.refusal);
  }
  return out.join("\n");
}

function normalizeHistoryForOpenAI(msgs: BaseMessage[]): BaseMessage[] {
  return msgs.map((msg) => {
    if (!isAIMessage(msg)) return msg;
    const nextContent = normalizeAssistantContentForOpenAI(msg.content);
    if (nextContent === msg.content) return msg;
    return new AIMessage({
      content: nextContent,
      tool_calls: msg.tool_calls,
      id: msg.id,
      name: msg.name,
      additional_kwargs: msg.additional_kwargs,
    });
  });
}

function rawVendorErrorText(err: unknown): string {
  if (err == null) return "Unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    if (err.cause) {
      const nested = rawVendorErrorText(err.cause);
      if (nested && nested !== "Unknown error")
        return `${err.message} | cause: ${nested}`;
    }
    return err.message;
  }
  if (typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  return String(err);
}

// ─── Node ────────────────────────────────────────────────────────────────────

/**
 * Roundtable `callModel` node.
 *
 * Same tool-loop architecture as `basicGraph/callModel` with two differences:
 * 1. Uses `SyncDelegateToDeepAgentTool` (blocking) instead of the async version.
 * 2. Does NOT include `DelegateToEpicOrchestratorTool` (no epic orchestration
 *    from inside a roundtable turn).
 */
export async function roundtableCallModelNode(
  state: AgentState,
  config: RunnableConfig,
): Promise<Partial<AgentState>> {
  if (state.error) return {};

  const {
    systemPrompt,
    messages: stateMessages,
    threadId,
    userId,
    agentId,
  } = state;

  const modelSlug = await resolveModelSlug(agentId);
  const vendor = await resolveVendor(modelSlug);

  if (!vendor) {
    const errMsg = `Unknown model "${modelSlug}". It may have been removed.`;
    logger.error("Roundtable: model not found", { modelSlug });
    return { error: errMsg };
  }
  if (!vendor.apiKey) {
    const errMsg = `API key not configured for ${vendor.slug}.`;
    logger.error("Roundtable: missing API key", {
      modelSlug,
      vendorSlug: vendor.slug,
    });
    return { error: errMsg };
  }

  logger.info("Roundtable: calling LLM", {
    modelSlug,
    vendorSlug: vendor.slug,
    messageCount: stateMessages.length,
    roundtableId: state.roundtableId,
  });

  const model = getModel(modelSlug, vendor.slug, vendor.apiKey);

  const mcpTools = agentId ? await getMcpTools(agentId) : [];

  const tools: StructuredToolInterface[] = [
    EditUserIdentityTool(state.userId),
    EditAgentNameTool(agentId),
    ConsultAgentTool(agentId, state.userId, state.groupId, state.singleChatId),
    ListAgentsTool(agentId),
    ListSystemAgentsTool(),
    SyncDelegateToDeepAgentTool(
      agentId,
      state.userId,
      state.groupId,
      state.singleChatId,
    ),
    ReadAgentNotesTool(agentId),
    AppendAgentNotesTool(agentId),
    EditAgentNotesTool(agentId),
    SaveEpisodicMemoryTool(agentId, state.userId, threadId),
    RecallEpisodicMemoryTool(agentId),
    ...workspaceTools(agentId),
    ...agentSkillTools(agentId),
    ListProjectsTool(state.userId),
    ListRepositoriesTool(),
    QueryDatabaseTool(),
    ...mcpTools,
  ];

  const toolByName = new Map<string, StructuredToolInterface>(
    tools.map((t) => [t.name, t]),
  );

  const bindTools = (
    model as BaseChatModel & { bindTools?: (t: unknown[]) => BaseChatModel }
  ).bindTools;
  if (typeof bindTools !== "function") {
    return {
      error:
        "This chat model does not support tool calling. Choose another model.",
    };
  }
  const modelWithTools = bindTools.call(model, tools);

  // ── Build LLM message array ───────────────────────────────────────────
  const llmMessages: BaseMessage[] = [new SystemMessage(systemPrompt)];

  for (const msg of stateMessages) {
    if (typeof (msg as any)._getType === "function") {
      const name = (msg as any).name;
      if (name && typeof name === "string") {
        (msg as any).name = sanitizeName(name);
      }
      if (isAIMessage(msg) && Array.isArray(msg.content)) {
        (msg as any).content = stripThinkingSignatures(msg.content);
      }
      llmMessages.push(msg);
    } else {
      const m = msg as any;
      const mType = m.role ?? m._type;
      if (mType === "human" || mType === "user") {
        llmMessages.push(
          new HumanMessage({
            content: m.content,
            ...(m.name ? { name: sanitizeName(m.name) } : {}),
          }),
        );
      } else if (mType === "assistant" || mType === "ai") {
        llmMessages.push(
          new AIMessage({
            content: normalizeAssistantContentForOpenAI(m.content),
            ...(Array.isArray(m.tool_calls) && m.tool_calls.length > 0
              ? { tool_calls: m.tool_calls }
              : {}),
          }),
        );
      } else if (mType === "tool") {
        llmMessages.push(
          new ToolMessage({
            content:
              typeof m.content === "string"
                ? m.content
                : m.content != null && typeof m.content === "object"
                  ? JSON.stringify(m.content)
                  : String(m.content ?? ""),
            tool_call_id:
              typeof m.tool_call_id === "string" ? m.tool_call_id : "",
          }),
        );
      }
    }
  }

  const llmMessagesForProvider =
    vendor.slug === "openai"
      ? normalizeHistoryForOpenAI(llmMessages)
      : llmMessages;

  // ── Tool loop ─────────────────────────────────────────────────────────
  try {
    let working: BaseMessage[] = llmMessagesForProvider;
    const newMessages: BaseMessage[] = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await modelWithTools.invoke(working, config);

      if (response instanceof AIMessage && Array.isArray(response.content)) {
        (response as any).content = stripThinkingSignatures(response.content);
      }

      const toolCalls =
        response instanceof AIMessage ? response.tool_calls : undefined;

      if (!toolCalls?.length) {
        (response as AIMessage).additional_kwargs = {
          ...(response as AIMessage).additional_kwargs,
          modelSlug,
          vendorSlug: vendor.slug,
          modelName: vendor.modelName,
        };
        newMessages.push(response);
        return { messages: newMessages };
      }

      newMessages.push(response);

      const toolMsgs: ToolMessage[] = [];
      for (const tc of toolCalls) {
        const t = tc.name ? toolByName.get(tc.name) : undefined;
        let content: string;
        if (!t) {
          logger.warn("Roundtable: unknown tool requested", {
            threadId,
            toolName: tc.name ?? null,
          });
          content = `Error: unknown tool "${tc.name ?? ""}".`;
        } else {
          try {
            const rawResult = await t.invoke(tc.args ?? {});
            if (typeof rawResult === "string") {
              content = rawResult;
            } else if (
              Array.isArray(rawResult) &&
              rawResult.length > 0 &&
              typeof rawResult[0] === "string"
            ) {
              content = rawResult[0];
            } else if (rawResult != null && typeof rawResult === "object") {
              content = JSON.stringify(rawResult);
            } else {
              content = String(rawResult ?? "");
            }
            logger.info("Roundtable: tool call completed", {
              threadId,
              tool: tc.name,
              round,
              resultLen: content.length,
            });
          } catch (toolErr) {
            logger.error("Roundtable: tool invocation failed", {
              threadId,
              tool: tc.name,
              error: rawVendorErrorText(toolErr),
            });
            content = `Error executing tool: ${rawVendorErrorText(toolErr)}`;
          }
        }
        toolMsgs.push(
          new ToolMessage({ content, tool_call_id: tc.id ?? "" }),
        );
      }

      newMessages.push(...toolMsgs);
      working = [...working, response, ...toolMsgs];
    }

    logger.warn("Roundtable: tool loop stopped after max rounds", {
      maxRounds: MAX_TOOL_ROUNDS,
    });
    return {
      error:
        "The agent requested too many tool calls in one roundtable turn.",
    };
  } catch (err) {
    const vendorText = rawVendorErrorText(err);
    logger.error("Roundtable: LLM invocation failed", {
      modelSlug,
      vendorSlug: vendor.slug,
      vendorError: vendorText,
    });
    return { error: vendorText };
  }
}
