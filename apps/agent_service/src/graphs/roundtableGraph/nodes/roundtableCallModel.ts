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
import { resolveModelSlug } from "../../../chat/modelResolution";
import { anthropicBaseConfig } from "../../../chat/anthropic/anthropicContextManagement";
import { AgentState } from "../../../state";
import { logger } from "../../../logger";
import { resolveOrgVendor } from "../../../utils/resolveOrgVendor.service";

import { EditUserIdentityTool } from "../../../tools/editUserIdentityTool";
import { EditAgentNameTool } from "../../../tools/agentNameTool";
import { ConsultAgentTool } from "../../../tools/consultAgentTool";
import { ListSystemAgentsTool } from "../../../tools/listSystemAgentsTool";
import { ListClaudeSubAgentsTool } from "../../../tools/listClaudeSubAgentsTool";
import { ListAgentsTool } from "../../../tools/listAgentsTool";
import { SyncDelegateToDeepAgentTool } from "../../../tools/syncDelegateToDeepAgentTool";
import { ReadAgentNotesTool, AppendAgentNotesTool, EditAgentNotesTool } from "../../../tools/agentNotesTool";
import { ListCronJobsTool } from "../../../tools/listCronJobsTool";
import { ListGoogleWorkspaceGrantsTool } from "../../../tools/listGoogleWorkspaceGrantsTool";
import { agentSkillTools } from "../../../tools/skillsTools";
import { SaveEpisodicMemoryTool, RecallEpisodicMemoryTool } from "../../../tools/episodicMemoryTool";
import { GetThreadSummaryTool } from "../../../tools/threadSummaryTool";
import { ReadSessionFileTool } from "../../../tools/readSessionFileTool";
import { GrepSessionFileTool } from "../../../tools/grepSessionFileTool";
import { ListProjectsTool, ListRepositoriesTool } from "../../../tools/epicTaskTools";
import { QueryDatabaseTool } from "../../../tools/queryDatabaseTool";
import { loadActiveToolSlugs } from "../../../tools/resolveAgentTools";
import getMcpTools from "../../../mcpClient";
import { instrumentFsWriteTools } from "../../../workspace/instrumentFsWriteTools";
import { drainSessionFileLedger } from "../../../workspace/sessionWorkspace";
import { runAnthropicAgentSdk, shouldUseAgentSdk } from "../../../chat/anthropic/agentSdkRunner";
import { runOpenAiCodexSdk, shouldUseCodexSdk } from "../../../chat/codex/codexSdkRunner";

const MAX_TOOL_ROUNDS = 15;

// ─── Vendor / model helpers (same as basicGraph/callModel) ───────────────────

function getModel(
  modelSlug: string,
  vendorSlug: string,
  apiKey: string,
): BaseChatModel {
  switch (vendorSlug) {
    case "openai":
      return new ChatOpenAI({ modelName: modelSlug, apiKey });
    case "anthropic":
      return new ChatAnthropic({
        modelName: modelSlug,
        apiKey,
        ...(process.env.MERIDIAN_URL
          ? { anthropicApiUrl: process.env.MERIDIAN_URL }
          : {}),
        ...anthropicBaseConfig(),
      });
    case "google":
      return new ChatGoogle({ model: modelSlug, apiKey });
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
  const vendor = await resolveOrgVendor(modelSlug, agentId);

  if (!vendor) {
    const errMsg = `Unknown model "${modelSlug}" or agent has no organization.`;
    logger.error("Roundtable: model not found", { modelSlug });
    return { error: errMsg };
  }
  if (!vendor.apiKey) {
    const errMsg = `Your organization has not configured an API key for ${vendor.vendorSlug}.`;
    logger.error("Roundtable: missing org API key", {
      modelSlug,
      vendorSlug: vendor.vendorSlug,
    });
    return { error: errMsg };
  }

  logger.info("Roundtable: calling LLM", {
    modelSlug,
    vendorSlug: vendor.vendorSlug,
    messageCount: stateMessages.length,
    roundtableId: state.roundtableId,
  });

  const model = getModel(modelSlug, vendor.vendorSlug, vendor.apiKey);

  // Wrap filesystem MCP write tools unconditionally — this enforces the
  // .md/.txt write-extension policy on every write, and additionally
  // captures writes inside the per-thread session folder into the ledger
  // when one exists for this thread.
  const rawMcpTools = agentId ? await getMcpTools(agentId) : [];
  const mcpTools = instrumentFsWriteTools(rawMcpTools, {
    threadId,
    sessionWorkspacePath: state.sessionWorkspacePath ?? undefined,
    source: "roundtable_agent",
  });

  const activeSlugs = await loadActiveToolSlugs(agentId);
  const has = (slug: string) => activeSlugs.has(slug);

  // Core tools — always available
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
    GrepSessionFileTool(agentId, threadId),
    ListCronJobsTool(agentId),
    ListGoogleWorkspaceGrantsTool(agentId),
    ...agentSkillTools(agentId),
    ...mcpTools,
    // Google Workspace (Gmail / Calendar / Drive) tools are not bound in the
    // roundtable — they live only on the `google_workspace_agent` system agent.
    // Delegate via `delegate_to_deep_agent`, passing the subject user's EMAIL
    // (resolved via list_google_workspace_grants).
    // Workspace + org-library access now ride on the filesystem MCP (see
    // `dev-in-house-workspace` / `dev-in-house-library-mcp` skills).
  ];

  // Configurable tools — gated by agent_available_tools
  if (has("consult_agent"))
    tools.push(ConsultAgentTool(agentId, state.userId, state.groupId, state.singleChatId));
  if (has("list_agents"))
    tools.push(ListAgentsTool(agentId));
  if (has("list_system_agents"))
    tools.push(ListSystemAgentsTool(agentId));
  if (has("delegate_to_deep_agent"))
    tools.push(SyncDelegateToDeepAgentTool(agentId, state.userId, state.groupId, state.singleChatId, state.threadId));
  if (has("list_projects"))
    tools.push(ListProjectsTool(state.userId));
  if (has("list_repositories"))
    tools.push(ListRepositoriesTool());
  if (has("query_database"))
    tools.push(QueryDatabaseTool());

  // Vendor-conditional auto-bind for Claude Agent SDK's `Task` discovery
  // (slice 19). The roundtable runner doesn't pass sub-agent bundles to
  // the SDK today, so the bound tool will always return "no sub-agents
  // attached" — but auto-binding it on Anthropic still keeps behaviour
  // uniform across graphs and prevents future drift if the roundtable
  // runner later acquires sub-agent fan-out.
  if (vendor.vendorSlug === "anthropic") {
    tools.push(ListClaudeSubAgentsTool(agentId));
  }

  // ─── Anthropic Agent SDK runtime branch ────────────────────────────────────
  //
  // Roundtables share threadId across multiple agents (one shared Claude
  // session would mix histories), so for roundtable turns we always run with
  // a fresh session. Forcing `claudeSessionId: null` per turn means every
  // invocation re-bootstraps from the system prompt rather than resuming a
  // session whose vendor-side history was generated by a different agent.
  //
  // The SDK runner collapses `state.messages` to just the latest moderator
  // HumanMessage via `extractLatestUserText`, so prior turns in the shared
  // thread are NOT reachable through the message channel on this branch.
  // Attribution of prior contributions is instead injected into the system
  // prompt by `roundtableContextBuilder` via `loadPriorRoundtableTurns` —
  // it queries `roundtable_messages` (the same source the UI reads) and
  // renders a "## Conversation so far" section labelled per speaker.
  //
  // The legacy `bindTools` branch below STILL does its own per-block
  // grouping of `state.messages` for non-SDK vendors, so the same content
  // reaches them via two independent routes; both must match what the user
  // sees in the UI.
  if (shouldUseAgentSdk(vendor.vendorSlug)) {
    return runAnthropicAgentSdk({
      state: { ...state, claudeSessionId: null },
      config,
      tools,
      vendor,
      modelSlug,
      maxTurns: MAX_TOOL_ROUNDS,
      source: "roundtable_agent",
    });
  }

  // ─── OpenAI Codex SDK runtime branch ───────────────────────────────────
  //
  // Same fresh-thread policy as the Anthropic branch: roundtables share
  // one threadId across multiple agents, and reusing a vendor-side session
  // would mix per-agent histories. Force `codexThreadId: null` per turn
  // so each roundtable invocation starts a fresh Codex thread; the
  // per-agent contextBuilder still builds an attribution-safe prompt.
  if (shouldUseCodexSdk(vendor.vendorSlug)) {
    return runOpenAiCodexSdk({
      state: { ...state, codexThreadId: null },
      config,
      tools,
      vendor,
      modelSlug,
      maxTurns: MAX_TOOL_ROUNDS,
      source: "roundtable_agent",
    });
  }

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
  //
  // The roundtable thread is shared across all participating agents under one
  // thread_id, so the checkpointer restores every prior turn into
  // `stateMessages`. If we passed those AIMessages through verbatim, the
  // current agent's LLM would read them as its own past output (an unnamed
  // AIMessage means "this assistant" in chat-completion semantics) and
  // could not distinguish "what others said" from "what I said".
  //
  // Fix: split state messages into per-turn blocks using the moderator
  // HumanMessage as a divider (each carries `additional_kwargs.agentId` for
  // its target agent — set by the worker). For blocks owned by another agent,
  // collapse the entire block into a single named HumanMessage carrying the
  // final reply text so attribution is unambiguous. Keep the current agent's
  // own past blocks verbatim so its tool reasoning stays in scope, and keep
  // the last block (the current turn) verbatim so its moderator HumanMessage
  // still prompts the model.

  const agentNameById = new Map<string, string>();
  const agentOrder: { agentId: string; definition: string }[] =
    (state as any).roundtableConfig?.agentOrder ?? [];
  for (const a of agentOrder) {
    if (a?.agentId) agentNameById.set(a.agentId, a.definition || a.agentId);
  }

  const messageType = (m: any): string | null => {
    if (m == null || typeof m !== "object") return null;
    if (typeof m._getType === "function") return m._getType();
    return (m.role ?? m._type ?? null) as string | null;
  };

  const additionalKwargs = (m: any): Record<string, unknown> => {
    if (m && typeof m === "object" && m.additional_kwargs && typeof m.additional_kwargs === "object") {
      return m.additional_kwargs as Record<string, unknown>;
    }
    return {};
  };

  const isModerator = (m: any): boolean => {
    if (m == null || typeof m !== "object" || m.name !== "roundtable_moderator") return false;
    const t = messageType(m);
    return t === "human" || t === "user";
  };

  type Block = {
    ownerAgentId: string | null;
    roundNumber: number | null;
    moderator: BaseMessage | null;
    body: BaseMessage[];
  };

  const blocks: Block[] = [];
  const prelude: BaseMessage[] = [];
  let cur: Block | null = null;
  for (const msg of stateMessages) {
    if (isModerator(msg)) {
      if (cur) blocks.push(cur);
      const akw = additionalKwargs(msg);
      cur = {
        ownerAgentId: typeof akw.agentId === "string" ? akw.agentId : null,
        roundNumber: typeof akw.roundNumber === "number" ? akw.roundNumber : null,
        moderator: msg,
        body: [],
      };
    } else if (cur) {
      cur.body.push(msg);
    } else {
      prelude.push(msg);
    }
  }
  if (cur) blocks.push(cur);

  const llmMessages: BaseMessage[] = [new SystemMessage(systemPrompt)];

  // Convert one state-message (BaseMessage instance OR serialized plain object)
  // into a normalized BaseMessage and append it to llmMessages. Same logic the
  // node used before block-grouping was added — preserves both shapes.
  const pushNormalized = (msg: any): void => {
    if (typeof msg?._getType === "function") {
      if (msg.name && typeof msg.name === "string") {
        (msg as any).name = sanitizeName(msg.name);
      }
      if (isAIMessage(msg) && Array.isArray(msg.content)) {
        (msg as any).content = stripThinkingSignatures(msg.content);
      }
      llmMessages.push(msg);
      return;
    }
    const mType = msg?.role ?? msg?._type;
    if (mType === "human" || mType === "user") {
      llmMessages.push(
        new HumanMessage({
          content: msg.content,
          ...(msg.name ? { name: sanitizeName(msg.name) } : {}),
        }),
      );
    } else if (mType === "assistant" || mType === "ai") {
      llmMessages.push(
        new AIMessage({
          content: normalizeAssistantContentForOpenAI(msg.content),
          ...(Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
            ? { tool_calls: msg.tool_calls }
            : {}),
        }),
      );
    } else if (mType === "tool") {
      llmMessages.push(
        new ToolMessage({
          content:
            typeof msg.content === "string"
              ? msg.content
              : msg.content != null && typeof msg.content === "object"
                ? JSON.stringify(msg.content)
                : String(msg.content ?? ""),
          tool_call_id:
            typeof msg.tool_call_id === "string" ? msg.tool_call_id : "",
        }),
      );
    }
  };

  // Pre-moderator messages (legacy threads or unexpected leading content)
  // pass through verbatim — there is no turn ownership to assert for them.
  for (const m of prelude) pushNormalized(m);

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const isLast = i === blocks.length - 1;
    const ownerKnown = block.ownerAgentId != null;
    const isOwn = ownerKnown && block.ownerAgentId === agentId;

    // Keep verbatim when:
    //  - it is the current turn (last block) — its moderator message prompts the model
    //  - the block is owned by this agent — preserve its own tool reasoning
    //  - the block has no owner tag — legacy pre-fix data; preserve old behavior
    if (isLast || isOwn || !ownerKnown) {
      if (block.moderator) pushNormalized(block.moderator);
      for (const m of block.body) pushNormalized(m);
      continue;
    }

    // Other-agent block: collapse to one named HumanMessage with the final
    // reply text. Tool-call interim AIMessages from other agents are not
    // useful here and would be orphaned anyway (matching ToolMessages get
    // dropped together with the block).
    const finalAi = [...block.body].reverse().find((m: any) => {
      const t = messageType(m);
      if (t !== "ai" && t !== "assistant") return false;
      const text = normalizeAssistantContentForOpenAI(m.content);
      return text.trim().length > 0;
    });
    if (!finalAi) continue;
    const text = normalizeAssistantContentForOpenAI((finalAi as any).content).trim();
    if (text.length === 0) continue;
    const ownerId = block.ownerAgentId as string;
    const displayName = agentNameById.get(ownerId) ?? ownerId;
    const roundLabel =
      block.roundNumber != null ? ` — Round ${block.roundNumber + 1}` : "";
    llmMessages.push(
      new HumanMessage({
        content: `[${displayName}${roundLabel} contribution]\n\n${text}`,
        name: sanitizeName(displayName),
      }),
    );
  }

  const llmMessagesForProvider =
    vendor.vendorSlug === "openai"
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
    const sessionFilesAtLimit = drainSessionFileLedger(threadId);
    return {
      error:
        "The agent requested too many tool calls in one roundtable turn.",
      ...(sessionFilesAtLimit.length > 0 ? { sessionFiles: sessionFilesAtLimit } : {}),
    };
  } catch (err) {
    const vendorText = rawVendorErrorText(err);
    logger.error("Roundtable: LLM invocation failed", {
      modelSlug,
      vendorSlug: vendor.vendorSlug,
      vendorError: vendorText,
    });
    const sessionFilesOnError = drainSessionFileLedger(threadId);
    return {
      error: vendorText,
      ...(sessionFilesOnError.length > 0 ? { sessionFiles: sessionFilesOnError } : {}),
    };
  }
}
