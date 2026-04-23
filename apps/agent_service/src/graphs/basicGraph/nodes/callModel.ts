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

/** Sanitize a name for the LLM API (OpenAI rejects spaces/special chars in message name). */
function sanitizeName(raw: string): string {
  return raw.replace(/[\s<|\\/>]+/g, "_").replace(/^_+|_+$/g, "") || "user";
}
import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { resolveModelSlug } from "../../../chat/modelResolution";
import { resolveOrgVendor } from "../../../services/resolveOrgVendor";
import { AgentState } from "../../../state";
import { logger } from "../../../logger";
import { EditUserIdentityTool } from "../../../tools/editUserIdentityTool";
import { EditAgentNameTool } from "../../../tools/agentNameTool";
import { ConsultAgentTool } from "../../../tools/consultAgentTool";
import { ListSystemAgentsTool } from "../../../tools/listSystemAgentsTool";
import { ListAgentsTool } from "../../../tools/listAgentsTool";
import { DelegateToDeepAgentTool } from "../../../tools/delegateToDeepAgentTool";
import { ReadAgentNotesTool, AppendAgentNotesTool, EditAgentNotesTool } from "../../../tools/agentNotesTool";
import { ListCronJobsTool } from "../../../tools/listCronJobsTool";
import { ListGoogleWorkspaceGrantsTool } from "../../../tools/listGoogleWorkspaceGrantsTool";
import { agentSkillTools } from "../../../tools/skillsTools";
import { DelegateToEpicOrchestratorTool } from "../../../tools/delegateToEpicOrchestratorTool";
import { SaveEpisodicMemoryTool, RecallEpisodicMemoryTool } from "../../../tools/episodicMemoryTool";
import { GetThreadSummaryTool } from "../../../tools/threadSummaryTool";
import { ReadSessionFileTool } from "../../../tools/readSessionFileTool";
import { ListProjectsTool, ListRepositoriesTool } from "../../../tools/epicTaskTools";
import { QueryDatabaseTool } from "../../../tools/queryDatabaseTool";
import { SendFileToUserTool } from "../../../tools/sendFileTool";
import { loadActiveToolSlugs } from "../../../tools/resolveAgentTools";
import getMcpTools from "../../../mcpClient";
import { instrumentFsWriteTools } from "../../../workspace/instrumentFsWriteTools";
import { drainSessionFileLedger } from "../../../workspace/sessionWorkspace";

/** Max model↔tool round-trips per graph step (prevents runaway loops). */
const MAX_TOOL_ROUNDS = 10;

/** Max characters for a single tool result before truncation. */
const MAX_TOOL_RESULT_CHARS = 10_000;

/**
 * Sanitizes a tool result before passing it back to the LLM:
 * - Truncates excessively long results to prevent context bloat.
 * - Detects error-shaped responses and prefixes them clearly.
 */
function sanitizeToolResult(content: string, toolName: string | undefined): string {
  // Detect error-shaped responses that the LLM might hallucinate from
  const looksLikeError =
    /^(Error:|ERROR:|HTTP\s+[45]\d\d|status\s*:\s*[45]\d\d|ECONNREFUSED|ETIMEDOUT|ENOTFOUND)/i.test(
      content.trim(),
    );
  if (looksLikeError && !content.startsWith("[TOOL ERROR]")) {
    content = `[TOOL ERROR] ${content}`;
  }

  // Truncate excessively long results
  if (content.length > MAX_TOOL_RESULT_CHARS) {
    const truncated = content.slice(0, MAX_TOOL_RESULT_CHARS);
    content =
      truncated +
      `\n\n[TRUNCATED — result was ${content.length.toLocaleString()} chars, showing first ${MAX_TOOL_RESULT_CHARS.toLocaleString()}. ` +
      `Tool: ${toolName ?? "unknown"}. If you need more detail, narrow your query.]`;
  }

  return content;
}




/**
 * Strips `signature` fields from `thinking` content blocks in an AI message's content.
 * Anthropic thinking blocks include large base64 signatures that are not needed for
 * conversation continuity and waste significant context tokens when re-sent.
 */
function stripThinkingSignatures(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part && typeof part === "object" && (part as Record<string, unknown>).type === "thinking") {
      const { signature, ...rest } = part as Record<string, unknown>;
      return rest;
    }
    return part;
  });
}

/**
 * OpenAI Chat Completions only allow specific `content` part types (`text`, `image_url`, …).
 * After tool calls, LangChain / checkpoints may store `content` as an array that still
 * includes `{ type: "functionCall", … }` blocks; OpenAI rejects those (they belong on `tool_calls`).
 */
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

/** Strips unsupported content parts from AI messages before sending to OpenAI. */
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

/**
 * Creates a LangChain chat model instance based on the vendor, model slug, and API key.
 * New models under a known vendor work automatically — no code changes needed.
 */
function getModel(modelSlug: string, vendorSlug: string, apiKey: string): BaseChatModel {
  switch (vendorSlug) {
    case "openai":
      return new ChatOpenAI({ modelName: modelSlug, temperature: 0.4, apiKey });
    case "anthropic":
      return new ChatAnthropic({
        modelName: modelSlug,
        temperature: 0.4,
        apiKey,
        ...(process.env.MERIDIAN_URL ? { anthropicApiUrl: process.env.MERIDIAN_URL } : {}),

      });
    case "google":
      return new ChatGoogle({ model: modelSlug, temperature: 0.4, apiKey });
    default:
      throw new Error(`Unsupported vendor "${vendorSlug}" for model "${modelSlug}"`);
  }
}

/**
 * Best-effort extraction of the provider's own error text (OpenAI / Anthropic / Google shapes).
 * Returned to the client and logged as-is.
 */
function rawVendorErrorText(err: unknown): string {
  if (err == null) return "Unknown error";
  if (typeof err === "string") return err;

  const tryStringify = (o: object): string | null => {
    try {
      return JSON.stringify(o);
    } catch {
      return null;
    }
  };

  const fromOpenAiStyle = (o: Record<string, unknown>): string | null => {
    const inner = o.error;
    if (inner && typeof inner === "object") {
      const e = inner as Record<string, unknown>;
      if (typeof e.message === "string") {
        const bits: string[] = [];
        if (typeof e.type === "string") bits.push(`type=${e.type}`);
        if (typeof e.code === "string") bits.push(`code=${e.code}`);
        if (typeof e.param === "string") bits.push(`param=${e.param}`);
        const suffix = bits.length ? ` (${bits.join(", ")})` : "";
        return `${e.message}${suffix}`;
      }
      const s = tryStringify(e as object);
      if (s) return s;
    }
    if (typeof o.message === "string") {
      const bits: string[] = [];
      if (typeof o.type === "string") bits.push(`type=${o.type}`);
      if (typeof o.code === "string") bits.push(`code=${o.code}`);
      const suffix = bits.length ? ` (${bits.join(", ")})` : "";
      return `${o.message}${suffix}`;
    }
    return null;
  };

  if (err instanceof Error) {
    const anyErr = err as Error & {
      status?: number;
      response?: { data?: unknown; status?: number };
      body?: unknown;
      error?: unknown;
    };
    if (anyErr.response?.data && typeof anyErr.response.data === "object") {
      const t = fromOpenAiStyle(anyErr.response.data as Record<string, unknown>);
      if (t) {
        const st = anyErr.response.status ?? anyErr.status;
        return st != null ? `HTTP ${st}: ${t}` : t;
      }
    }
    if (anyErr.body && typeof anyErr.body === "object") {
      const t = fromOpenAiStyle(anyErr.body as Record<string, unknown>);
      if (t) return t;
    }
    if (anyErr.error && typeof anyErr.error === "object") {
      const t = fromOpenAiStyle({ error: anyErr.error } as Record<string, unknown>);
      if (t) return t;
    }
    if (err.cause) {
      const nested = rawVendorErrorText(err.cause);
      if (nested && nested !== "Unknown error") return `${err.message} | cause: ${nested}`;
    }
    return err.message;
  }

  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    const direct = fromOpenAiStyle(o);
    if (direct) return direct;
    const s = tryStringify(err as object);
    if (s) return s;
  }

  return String(err);
}

/**
 * LangGraph node that calls the LLM.
 * Validates the API key first; on LLM errors, returns the provider's raw error text.
 */
export async function callModelNode(
  state: AgentState,
  config: RunnableConfig,
): Promise<Partial<AgentState>> {
  const { systemPrompt, messages: stateMessages, singleChatId, groupId, threadId, userId, agentId } =
    state;

  const modelSlug = await resolveModelSlug(agentId);

  // Resolve vendor + org-scoped API key from DB
  const vendor = await resolveOrgVendor(modelSlug, agentId);
  logger.info("Vendor resolved", { vendorSlug: vendor?.vendorSlug });
  if (!vendor) {
    const errMsg = `Unknown model "${modelSlug}" or agent has no organization. Please select a different model.`;
    logger.error("Model/org not resolvable", { modelSlug, agentId });
    return { error: errMsg };
  }

  if (!vendor.apiKey) {
    const errMsg = `Your organization has not configured an API key for ${vendor.vendorSlug}. Ask a super_admin to upload one in the admin panel, or switch to a different model.`;
    logger.error("Missing org-scoped API key for vendor", { modelSlug, vendorSlug: vendor.vendorSlug, agentId });
    return { error: errMsg };
  }

  logger.info("Calling LLM", { modelSlug, vendorSlug: vendor.vendorSlug, messageCount: stateMessages.length });

  const model = getModel(modelSlug, vendor.vendorSlug, vendor.apiKey);

  // Load MCP tools assigned to this agent via agent_available_mcp_servers.
  // The wrapper is applied unconditionally — it enforces the .md/.txt
  // write-extension policy on every filesystem MCP write, and additionally
  // captures writes inside the per-thread session folder into the ledger
  // when one exists for this thread.
  const rawMcpTools = agentId ? await getMcpTools(agentId) : [];
  const mcpTools = instrumentFsWriteTools(rawMcpTools, {
    threadId,
    sessionWorkspacePath: state.sessionWorkspacePath ?? undefined,
    source: "primary_agent",
  });

  // Load configurable tool slugs from agent_available_tools.
  // null = no assignments exist yet → include all for backward compatibility.
  const activeSlugs = await loadActiveToolSlugs(agentId);
  const has = (slug: string) => activeSlugs.has(slug);

  // Core tools — always available regardless of DB assignments
  const tools: StructuredToolInterface[] = [
    EditUserIdentityTool(state.userId),
    EditAgentNameTool(agentId),
    ReadAgentNotesTool(agentId),
    AppendAgentNotesTool(agentId),
    EditAgentNotesTool(agentId),
    SaveEpisodicMemoryTool(agentId, state.userId, threadId),
    RecallEpisodicMemoryTool(agentId),
    GetThreadSummaryTool(agentId),
    ReadSessionFileTool(agentId, threadId),
    ListCronJobsTool(agentId),
    ListGoogleWorkspaceGrantsTool(agentId),
    ...agentSkillTools(agentId),
    ...mcpTools,
    // Google Workspace tools (Gmail / Calendar / Drive) are NOT bound to
    // primary agents — they live only on the `google_workspace_agent` system
    // agent. Primary agents must delegate those ops via `delegate_to_deep_agent`,
    // passing the subject user's EMAIL (resolved via list_google_workspace_grants).
    // Workspace + org-library access now ride on the filesystem MCP (see
    // `dev-in-house-workspace` / `dev-in-house-library-mcp` skills) — no
    // dedicated tool bindings here.
  ];

  // Configurable tools — gated by agent_available_tools assignments
  if (has("consult_agent"))
    tools.push(ConsultAgentTool(agentId, state.userId, state.groupId, state.singleChatId));
  if (has("list_agents"))
    tools.push(ListAgentsTool(agentId));
  if (has("list_system_agents"))
    tools.push(ListSystemAgentsTool(agentId));
  if (has("delegate_to_deep_agent"))
    tools.push(DelegateToDeepAgentTool(agentId, state.userId, state.groupId, state.singleChatId, state.threadId));
  if (has("delegate_to_epic_orchestrator"))
    tools.push(DelegateToEpicOrchestratorTool(agentId, state.userId, state.groupId, state.singleChatId));
  if (has("list_projects"))
    tools.push(ListProjectsTool(state.userId));
  if (has("list_repositories"))
    tools.push(ListRepositoriesTool());
  if (has("query_database"))
    tools.push(QueryDatabaseTool());
  if (has("send_file_to_user"))
    tools.push(SendFileToUserTool(agentId));
  const toolByName = new Map<string, StructuredToolInterface>(
    tools.map((t) => [t.name, t]),
  );

  const bindTools = (model as BaseChatModel & { bindTools?: (t: unknown[]) => BaseChatModel })
    .bindTools;
  if (typeof bindTools !== "function") {
    logger.error("Chat model does not support bindTools; core memory tool unavailable", {
      modelSlug,
    });
    return {
      error:
        "This chat model does not support tool calling. Choose another model or update the integration.",
    };
  }
  const modelWithTools = bindTools.call(model, tools);

  const llmMessages: BaseMessage[] = [new SystemMessage(systemPrompt)];

  for (const msg of stateMessages) {
    if (typeof (msg as any)._getType === "function") {
      // Deserialized LangChain message — sanitize name if present
      const name = (msg as any).name;
      if (name && typeof name === "string") {
        (msg as any).name = sanitizeName(name);
      }
      // Strip thinking-block signatures from prior AI messages to save context tokens
      if (isAIMessage(msg) && Array.isArray(msg.content)) {
        (msg as any).content = stripThinkingSignatures(msg.content);
      }
      llmMessages.push(msg);
    } else {
      const m = msg as any;
      const mType = m.role ?? m._type;
      if (mType === "human" || mType === "user") {
        llmMessages.push(new HumanMessage({ content: m.content, ...(m.name ? { name: sanitizeName(m.name) } : {}) }));
      } else if (mType === "assistant" || mType === "ai") {
        llmMessages.push(
          new AIMessage({
            content: normalizeAssistantContentForOpenAI(m.content),
            ...(Array.isArray(m.tool_calls) && m.tool_calls.length > 0 ? { tool_calls: m.tool_calls } : {}),
          }),
        );
      } else if (mType === "tool") {
        llmMessages.push(
          new ToolMessage({
            content: typeof m.content === "string"
              ? m.content
              : m.content != null && typeof m.content === "object"
                ? JSON.stringify(m.content)
                : String(m.content ?? ""),
            tool_call_id: typeof m.tool_call_id === "string" ? m.tool_call_id : "",
          }),
        );
      }
    }
  }

  const llmMessagesForProvider =
    vendor.vendorSlug === "openai" ? normalizeHistoryForOpenAI(llmMessages) : llmMessages;

  try {
    let working: BaseMessage[] = llmMessagesForProvider;
    const newMessages: BaseMessage[] = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await modelWithTools.invoke(working, config);

      // Strip thinking-block signatures from the response before checkpoint storage
      if (response instanceof AIMessage && Array.isArray(response.content)) {
        (response as any).content = stripThinkingSignatures(response.content);
      }

      const toolCalls =
        response instanceof AIMessage ? response.tool_calls : undefined;

      if (!toolCalls?.length) {
        (response as AIMessage).additional_kwargs = {
          ...(response as AIMessage).additional_kwargs,
          modelSlug,
          vendorSlug: vendor.vendorSlug,
          modelName: vendor.modelName,
        };
        newMessages.push(response);
        const sessionFiles = drainSessionFileLedger(threadId);
        return sessionFiles.length > 0
          ? { messages: newMessages, sessionFiles }
          : { messages: newMessages };
      }

      newMessages.push(response);

      const toolMsgs: ToolMessage[] = [];
      for (const tc of toolCalls) {
        const t = tc.name ? toolByName.get(tc.name) : undefined;
        let content: string;
        if (!t) {
          logger.warn("Unknown tool requested by model", {
            threadId,
            userId,
            toolName: tc.name ?? null,
            toolCallId: tc.id,
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
              // MCP tools return [content, artifacts] tuples
              content = rawResult[0];
            } else if (rawResult != null && typeof rawResult === "object") {
              content = JSON.stringify(rawResult);
            } else {
              content = String(rawResult ?? "");
            }
            const raw = tc.args as Record<string, unknown> | undefined;
            const text = typeof raw?.content === "string" ? raw.content : "";
            logger.info("Tool call completed", {
              threadId,
              userId,
              tool: tc.name,
              toolCallId: tc.id,
              round,
              action: typeof raw?.action === "string" ? raw.action : undefined,
              contentLength: text.length,
              argsPreview:
                raw != null
                  ? JSON.stringify(raw).length > 400
                    ? `${JSON.stringify(raw).slice(0, 400)}…`
                    : JSON.stringify(raw)
                  : undefined,
              resultPreview:
                content.length > 300 ? `${content.slice(0, 300)}…` : content,
            });
          } catch (toolErr) {
            logger.error("Tool invocation failed", {
              threadId,
              userId,
              tool: tc.name,
              toolCallId: tc.id,
              error: rawVendorErrorText(toolErr),
            });
            content = `[TOOL ERROR] Error executing tool: ${rawVendorErrorText(toolErr)}`;
          }
        }

        // Sanitize: truncate long results, tag error-shaped responses
        content = sanitizeToolResult(content, tc.name);

        toolMsgs.push(
          new ToolMessage({
            content,
            tool_call_id: tc.id ?? "",
          }),
        );
      }

      newMessages.push(...toolMsgs);
      working = [...working, response, ...toolMsgs];
    }

    logger.warn("Tool loop stopped after max rounds", { maxRounds: MAX_TOOL_ROUNDS });
    const sessionFilesAtLimit = drainSessionFileLedger(threadId);
    return {
      error: "The assistant requested too many tool calls in one turn. Please try again.",
      ...(sessionFilesAtLimit.length > 0 ? { sessionFiles: sessionFilesAtLimit } : {}),
    };
  } catch (err) {
    const vendorText = rawVendorErrorText(err);
    logger.error("LLM invocation failed", { modelSlug, vendorSlug: vendor.vendorSlug, vendorError: vendorText });
    const sessionFilesOnError = drainSessionFileLedger(threadId);
    return {
      error: vendorText,
      ...(sessionFilesOnError.length > 0 ? { sessionFiles: sessionFilesOnError } : {}),
    };
  }
}
