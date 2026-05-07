/**
 * callModel node for the Epic Orchestrator graph.
 *
 * Same LLM invocation loop as the basic graph, but with a focused tool set:
 * - Epic task tools (plan, execute, status, review)
 * - Project/repository listing
 * - Agent notes, workspace, skills
 * - Optional: list_system_agents + delegate_to_deep_agent (same as primary orchestrators)
 *   for codebase exploration; epic coding still runs via epic task tools.
 */
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogle } from "@langchain/google";
import { ChatAnthropic } from "@langchain/anthropic";
import { anthropicBaseConfig } from "../../../chat/anthropic/anthropicContextManagement";
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
import { AgentState } from "../../../state";
import { logger } from "../../../logger";
import { resolveOrgVendor } from "../../../utils/resolveOrgVendor.service";
import { ReadAgentNotesTool, AppendAgentNotesTool, EditAgentNotesTool } from "../../../tools/agentNotesTool";
import { ListCronJobsTool } from "../../../tools/listCronJobsTool";
import { ListGoogleWorkspaceGrantsTool } from "../../../tools/listGoogleWorkspaceGrantsTool";
import { agentSkillTools } from "../../../tools/skillsTools";
import { ConsultAgentTool } from "../../../tools/consultAgentTool";
import { ListAgentsTool } from "../../../tools/listAgentsTool";
import {
  DelegateToDeepAgentTool,
} from "../../../tools/delegateToDeepAgentTool";
import { ListSystemAgentsTool } from "../../../tools/listSystemAgentsTool";
import { ListClaudeSubAgentsTool } from "../../../tools/listClaudeSubAgentsTool";
import { SaveEpisodicMemoryTool, RecallEpisodicMemoryTool } from "../../../tools/episodicMemoryTool";
import { GetThreadSummaryTool } from "../../../tools/threadSummaryTool";
import { ListMyThreadsTool } from "../../../tools/threadRecallTools";
import {
  ListMyRoundtablesTool,
  GetRoundtableOverviewTool,
} from "../../../tools/roundtableRecallTools";
import {
  ListProjectsTool,
  ListRepositoriesTool,
  GetRepositoryTool,
  CreateEpicPlanTool,
  PlanEpicTaskCodexTool,
  StartEpicTaskCodexTool,
  CompleteEpicTaskTool,
  GetEpicStatusTool,
  ReviewTaskDiffTool,
  UpdateStagePrTool,
  ForceApproveStagePrTool,
  ApproveStageTool,
  RequestStageChangesTool,
  ResetStuckTaskTool,
  CancelEpicTool,
  SearchEpicTasksByDateTool,
  GetEpicTaskStagesAndTasksTool,
  parseContinuationMarker,
  StartAnthropicEpicTaskTool,
} from "../../../tools/epicTaskTools";
import { SendFileToUserTool } from "../../../tools/sendFileTool";
import { UnsplashSearchPhotosTool } from "../../../tools/unsplashPhotoTool";
import { loadActiveToolSlugs } from "../../../tools/resolveAgentTools";
import getMcpTools from "../../../mcpClient";
import { instrumentFsWriteTools } from "../../../workspace/instrumentFsWriteTools";
import { drainSessionFileLedger } from "../../../workspace/sessionWorkspace";
import { runAnthropicAgentSdk, shouldUseAgentSdk } from "../../../chat/anthropic/agentSdkRunner";
import { runOpenAiCodexSdk, shouldUseCodexSdk } from "../../../chat/codex/codexSdkRunner";
import { buildSubAgentDefinitions } from "../../../utils/buildSubAgentDefinitions.service";
import { observeToolCall } from "../../../langfuse";

// Cap the orchestrator's tool-call chain per chat turn. This is the EPIC
// orchestrator, which legitimately chains many tool calls: setup checks
// (list_agent_skills, get_agent_skill, get_epic_status), then 2+ rounds
// per task in the stage (execute_epic_task + review_task_diff), then
// reporting calls. A 10-cap was tripping even on normal retry flows —
// a stage with 4 tasks already costs ~3 setup + 8 execution = 11 rounds.
// 30 gives headroom for ~10-task stages with room to spare, while still
// acting as a safety net against a runaway self-loop.
const MAX_TOOL_ROUNDS = 30;

function sanitizeName(raw: string): string {
  return raw.replace(/[\s<|\\/>]+/g, "_").replace(/^_+|_+$/g, "") || "user";
}

function getModel(modelSlug: string, vendorSlug: string, apiKey: string): BaseChatModel {
  if (vendorSlug === "openai") {
    return new ChatOpenAI({ modelName: modelSlug, apiKey });
  }
  if (vendorSlug === "anthropic") {
    return new ChatAnthropic({
      modelName: modelSlug,
      apiKey,
      ...anthropicBaseConfig(),
    });
  }
  if (vendorSlug === "google") {
    return new ChatGoogle({ model: modelSlug, apiKey });
  }
  return new ChatOpenAI({ modelName: modelSlug, apiKey });
}

function rawVendorErrorText(err: unknown): string {
  if (err instanceof Error) {
    const anyErr = err as any;
    return anyErr?.response?.data?.error?.message ?? anyErr?.error?.message ?? err.message;
  }
  return String(err);
}

/** Strip thinking-block signatures from AI message content arrays. */
function stripThinkingSignatures(content: unknown[]): unknown[] {
  return content.filter((c: any) => c?.type !== "thinking" || !c?.signature);
}

/** Ensure assistant content is a string for OpenAI (it rejects content arrays with only text). */
function normalizeAssistantContentForOpenAI(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const part of content) {
    if (typeof part === "string") { out.push(part); continue; }
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") out.push(p.text);
  }
  return out.join("\n");
}

/** Ensure history doesn't start with a non-human message after the system message. */
function normalizeHistoryForOpenAI(msgs: BaseMessage[]): BaseMessage[] {
  if (msgs.length < 2) return msgs;
  const result: BaseMessage[] = [msgs[0]];
  let needsHuman = true;
  for (let i = 1; i < msgs.length; i++) {
    const m = msgs[i];
    const t = typeof (m as any)._getType === "function" ? (m as any)._getType() : null;
    if (needsHuman && t !== "human") {
      result.push(new HumanMessage({ content: "(conversation continued)", name: "system" }));
    }
    needsHuman = false;
    result.push(m);
  }
  return result;
}

export async function epicCallModelNode(
  state: AgentState,
  config: RunnableConfig,
): Promise<Partial<AgentState>> {
  if (state.error) return {};

  const agentId = state.agentId;
  const threadId = state.threadId;
  const userId = state.userId;
  const modelSlug = state.modelSlug || "gpt-4o";
  const systemPrompt = state.systemPrompt;
  const stateMessages = state.messages ?? [];

  if (!systemPrompt) {
    return { error: "No system prompt assembled. Context builder may have failed." };
  }

  const vendor = await resolveOrgVendor(modelSlug, agentId);
  if (!vendor) {
    return { error: `Unknown model "${modelSlug}" or agent has no organization.` };
  }
  if (!vendor.apiKey) {
    return { error: `Your organization has not configured an API key for ${vendor.vendorSlug}.` };
  }

  const model = getModel(modelSlug, vendor.vendorSlug, vendor.apiKey);

  // Load MCP tools assigned to this agent (bash, filesystem servers).
  // The wrapper is applied unconditionally — it enforces the .md/.txt
  // write-extension policy on every filesystem MCP write, and additionally
  // captures writes inside the per-thread session folder into the ledger
  // when one exists for this thread.
  const rawMcpTools = await getMcpTools(agentId);
  const mcpTools = instrumentFsWriteTools(rawMcpTools, {
    threadId,
    sessionWorkspacePath: state.sessionWorkspacePath ?? undefined,
    source: "epic_orchestrator",
  });

  const activeSlugs = await loadActiveToolSlugs(agentId);
  const has = (slug: string) => activeSlugs.has(slug);

  // Core + epic-specific tools (always available for epic agents)
  const tools: StructuredToolInterface[] = [
    ReadAgentNotesTool(agentId),
    AppendAgentNotesTool(agentId),
    EditAgentNotesTool(agentId),
    SaveEpisodicMemoryTool(agentId, userId, threadId),
    RecallEpisodicMemoryTool(agentId),
    GetThreadSummaryTool(agentId),
    // Thread recall — non-vector entry point into past single-chat /
    // group conversations the epic orchestrator owned. After picking a
    // thread, `get_thread_summary` returns the manifest and the agent
    // reads files from `<workspacePath>/threads/<threadId>/` using its
    // own filesystem tools (Read/Glob/Grep SDK built-ins or
    // read_text_file/search_files via filesystem MCP).
    ListMyThreadsTool(agentId),
    // Roundtable recall — the epic orchestrator can pull short summaries
    // of past roundtables it participated in to inform planning. Same
    // access gating as elsewhere (caller agentId must appear in
    // roundtable_agents for the row in question).
    ListMyRoundtablesTool(agentId),
    GetRoundtableOverviewTool(agentId),
    ListCronJobsTool(agentId),
    ListGoogleWorkspaceGrantsTool(agentId),
    ...agentSkillTools(agentId),
    // Google Workspace (Gmail / Calendar / Drive) tools are not bound here —
    // they live only on the `google_workspace_agent` system agent. Delegate via
    // `delegate_to_deep_agent`, passing the subject user's EMAIL (resolved via
    // list_google_workspace_grants).
    // Workspace + org-library access now ride on the filesystem MCP (see
    // `dev-in-house-workspace` / `dev-in-house-library-mcp` skills).
    // Epic workflow tools (always on for epic agents)
    CreateEpicPlanTool(state.userId, agentId),
    // Vendor-conditional task-execution surface (slices 20 + 23):
    //   - Anthropic vendor: `start_epic_task` declares a sub-agent slice
    //     plan, the orchestrator then fans out via `Task("<id>", ...)`
    //     calls in parallel.
    //   - OpenAI / Codex vendor: optional `plan_epic_task` (read-only
    //     scout) + `start_epic_task_codex` (detached workspace-write execute).
    //     One Codex session does the whole task end-to-end inside its
    //     own loop — no sub-agent fan-out (Codex SDK doesn't have a
    //     parallel-Task equivalent and concurrent codex sessions on
    //     one repo race on the git index). Codex auto-finalizes server-side;
    //     poll `get_epic_status` — do not pair with `complete_epic_task`.
    // `complete_epic_task` finalizes the Anthropic (`start_epic_task`) path only.
    ...(vendor.vendorSlug === "anthropic"
      ? [StartAnthropicEpicTaskTool(agentId)]
      : vendor.vendorSlug === "openai"
        ? [
            PlanEpicTaskCodexTool(agentId),
            StartEpicTaskCodexTool(agentId, {
              threadId,
              sessionWorkspacePath: state.sessionWorkspacePath ?? null,
              userId,
              groupId: state.groupId,
              singleChatId: state.singleChatId,
            }),
          ]
        : []),
    CompleteEpicTaskTool({
      threadId,
      userId,
      groupId: state.groupId,
      singleChatId: state.singleChatId,
    }),
    GetEpicStatusTool(),
    ReviewTaskDiffTool(),
    UpdateStagePrTool(),
    ForceApproveStagePrTool(),
    ApproveStageTool(),
    RequestStageChangesTool(),
    ResetStuckTaskTool(),
    CancelEpicTool(),
    ...mcpTools,
  ];

  // Configurable tools — gated by agent_available_tools
  if (has("list_agents"))
    tools.push(ListAgentsTool(agentId));
  if (has("consult_agent"))
    tools.push(ConsultAgentTool(agentId, state.userId, state.groupId, state.singleChatId));
  if (has("list_system_agents"))
    tools.push(ListSystemAgentsTool(agentId));
  if (has("delegate_to_deep_agent"))
    tools.push(DelegateToDeepAgentTool(agentId, state.userId, state.groupId, state.singleChatId, state.threadId));
  if (has("list_projects"))
    tools.push(ListProjectsTool(state.userId));
  if (has("list_repositories"))
    tools.push(ListRepositoriesTool());
  if (has("get_repository"))
    tools.push(GetRepositoryTool());
  if (has("send_file_to_user"))
    tools.push(SendFileToUserTool(agentId));
  if (has("unsplash_search_photos"))
    tools.push(UnsplashSearchPhotosTool());
  if (has("search_epic_tasks_by_date"))
    tools.push(SearchEpicTasksByDateTool());
  if (has("get_epic_task_stages_and_tasks"))
    tools.push(GetEpicTaskStagesAndTasksTool());

  // Vendor-conditional auto-bind for Claude Agent SDK's `Task` discovery
  // (slice 19). Same rationale as the basicGraph variant — this tool is
  // useful only when the runner is the Anthropic SDK, so we surface it
  // exclusively to Anthropic-vendor agents.
  if (vendor.vendorSlug === "anthropic") {
    tools.push(ListClaudeSubAgentsTool(agentId));
  }

  // ─── Anthropic Agent SDK runtime branch ────────────────────────────────────
  //
  // Same as basicGraph, plus an `onToolResult` observer that watches for the
  // `[EPIC_CONTINUATION]` marker emitted by `start_epic_task`. When seen,
  // we capture the parsed continuation so the worker can auto-enqueue the next
  // task — exactly the same signal the legacy loop returned via
  // `state.epicContinuation`.
  //
  // The legacy loop also emitted a wrap-up assistant message after the marker
  // (a hint asking the model to update the user without further tool calls).
  // The SDK manages its own loop autonomously, so the model will already have
  // produced its own closing message in `result.finalText` by the time we see
  // the marker. We just need to flag the continuation; no second invoke needed.
  if (shouldUseAgentSdk(vendor.vendorSlug)) {
    // Same sub-agent fan-out as basicGraph — epic orchestrator can also call
    // Task("<sub-agent id>", ...) to delegate research / inspection work
    // to specialists. Code-change execution still flows through the epic task
    // tools (`start_epic_task` etc.), unchanged.
    const subAgents = await buildSubAgentDefinitions({
      primaryAgentId: agentId,
      userId,
      threadId,
      groupId: state.groupId,
      singleChatId: state.singleChatId,
    });

    let detectedContinuation: { epicId: string; completedTaskTitle: string; remainingTasks: number } | null = null;
    const sdkPatch = await runAnthropicAgentSdk({
      state,
      config,
      tools,
      vendor,
      modelSlug,
      maxTurns: MAX_TOOL_ROUNDS,
      source: "epic_orchestrator",
      subAgents,
      onToolResult: ({ text }) => {
        if (detectedContinuation) return;
        const cont = parseContinuationMarker(text);
        if (cont) {
          detectedContinuation = cont;
          logger.info("Epic continuation detected (SDK path)", {
            epicId: cont.epicId,
            completedTask: cont.completedTaskTitle,
            remaining: cont.remainingTasks,
          });
        }
      },
    });
    if (detectedContinuation && !sdkPatch.error) {
      return { ...sdkPatch, epicContinuation: detectedContinuation };
    }
    return sdkPatch;
  }

  // ─── OpenAI Codex SDK runtime branch ───────────────────────────────────
  //
  // Same observer-driven EPIC_CONTINUATION detection as the Anthropic
  // branch above. Codex's `mcp_tool_call` events flow through the bridge,
  // and the runner forwards each tool result text to `onToolResult` —
  // identical contract to the Anthropic runner so this code path stays
  // structurally symmetric.
  if (shouldUseCodexSdk(vendor.vendorSlug)) {
    let detectedContinuation: { epicId: string; completedTaskTitle: string; remainingTasks: number } | null = null;
    const sdkPatch = await runOpenAiCodexSdk({
      state,
      config,
      tools,
      vendor,
      modelSlug,
      maxTurns: MAX_TOOL_ROUNDS,
      source: "epic_orchestrator",
      onToolResult: ({ text }: { text: string }) => {
        if (detectedContinuation) return;
        const cont = parseContinuationMarker(text);
        if (cont) {
          detectedContinuation = cont;
          logger.info("Epic continuation detected (Codex SDK path)", {
            epicId: cont.epicId,
            completedTask: cont.completedTaskTitle,
            remaining: cont.remainingTasks,
          });
        }
      },
    });
    if (detectedContinuation && !sdkPatch.error) {
      return { ...sdkPatch, epicContinuation: detectedContinuation };
    }
    return sdkPatch;
  }

  const toolByName = new Map<string, StructuredToolInterface>(
    tools.map((t) => [t.name, t]),
  );

  const bindTools = (model as BaseChatModel & { bindTools?: (t: unknown[]) => BaseChatModel }).bindTools;
  if (typeof bindTools !== "function") {
    return { error: "This chat model does not support tool calling." };
  }
  const modelWithTools = bindTools.call(model, tools);

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
            content: typeof m.content === "string" ? m.content : m.content != null && typeof m.content === "object" ? JSON.stringify(m.content) : String(m.content ?? ""),
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

      if (response instanceof AIMessage && Array.isArray(response.content)) {
        (response as any).content = stripThinkingSignatures(response.content);
      }

      const toolCalls = response instanceof AIMessage ? response.tool_calls : undefined;

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
          content = `Error: unknown tool "${tc.name ?? ""}".`;
        } else {
          try {
            // Tool execution surfaces in Langfuse as a child span of
            // `agent_chat_turn` (or whichever parent observation is
            // active) so retry-loop tool calls — list_skills,
            // get_skill, get_epic_status, etc. — show up alongside the
            // generation spans in the trace.
            const rawResult = await observeToolCall(
              tc.name ?? "unknown_tool",
              tc.args ?? {},
              () => t.invoke(tc.args ?? {}),
            );
            if (typeof rawResult === "string") {
              content = rawResult;
            } else if (Array.isArray(rawResult) && rawResult.length > 0 && typeof rawResult[0] === "string") {
              content = rawResult[0];
            } else if (rawResult != null && typeof rawResult === "object") {
              content = JSON.stringify(rawResult);
            } else {
              content = String(rawResult ?? "");
            }
            logger.info("Epic tool call completed", { threadId, tool: tc.name, round });
          } catch (toolErr) {
            logger.error("Epic tool invocation failed", { threadId, tool: tc.name, error: rawVendorErrorText(toolErr) });
            content = `Error executing tool: ${rawVendorErrorText(toolErr)}`;
          }
        }
        toolMsgs.push(new ToolMessage({ content, tool_call_id: tc.id ?? "" }));
      }

      newMessages.push(...toolMsgs);
      working = [...working, response, ...toolMsgs];

      // Check for epic continuation marker
      for (const tm of toolMsgs) {
        const content = typeof tm.content === "string" ? tm.content : "";
        const continuation = parseContinuationMarker(content);
        if (continuation) {
          logger.info("Epic continuation detected", {
            epicId: continuation.epicId,
            completedTask: continuation.completedTaskTitle,
            remaining: continuation.remainingTasks,
          });

          const hintMsg = new HumanMessage({
            content:
              `[System: Task "${continuation.completedTaskTitle}" is done. ` +
              `${continuation.remainingTasks} task(s) remain and will be executed automatically in the next turn. ` +
              `Provide a brief progress update to the user. Do NOT call any more tools.]`,
            name: "system",
          });
          working.push(hintMsg);

          const wrapUpResponse = await modelWithTools.invoke(working, config);
          if (wrapUpResponse instanceof AIMessage && Array.isArray(wrapUpResponse.content)) {
            (wrapUpResponse as any).content = stripThinkingSignatures(wrapUpResponse.content);
          }
          (wrapUpResponse as AIMessage).additional_kwargs = {
            ...(wrapUpResponse as AIMessage).additional_kwargs,
            modelSlug,
            vendorSlug: vendor.vendorSlug,
            modelName: vendor.modelName,
          };
          newMessages.push(wrapUpResponse);

          const sessionFilesAtCont = drainSessionFileLedger(threadId);
          return sessionFilesAtCont.length > 0
            ? { messages: newMessages, epicContinuation: continuation, sessionFiles: sessionFilesAtCont }
            : { messages: newMessages, epicContinuation: continuation };
        }
      }
    }

    logger.warn("Epic tool loop stopped after max rounds", { maxRounds: MAX_TOOL_ROUNDS });
    const sessionFilesAtLimit = drainSessionFileLedger(threadId);
    return {
      error: "Too many tool calls in one turn.",
      ...(sessionFilesAtLimit.length > 0 ? { sessionFiles: sessionFilesAtLimit } : {}),
    };
  } catch (err) {
    const vendorText = rawVendorErrorText(err);
    logger.error("Epic LLM invocation failed", { modelSlug, vendorSlug: vendor.vendorSlug, error: vendorText });
    const sessionFilesOnError = drainSessionFileLedger(threadId);
    return {
      error: vendorText,
      ...(sessionFilesOnError.length > 0 ? { sessionFiles: sessionFilesOnError } : {}),
    };
  }
}
