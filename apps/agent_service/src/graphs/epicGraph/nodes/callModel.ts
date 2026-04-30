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
import { anthropicBaseConfig } from "../../../chat/anthropicContextManagement";
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
import { resolveOrgVendor } from "../../../services/resolveOrgVendor.service";
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
import { SaveEpisodicMemoryTool, RecallEpisodicMemoryTool } from "../../../tools/episodicMemoryTool";
import { GetThreadSummaryTool } from "../../../tools/threadSummaryTool";
import { ReadSessionFileTool } from "../../../tools/readSessionFileTool";
import { GrepSessionFileTool } from "../../../tools/grepSessionFileTool";
import {
  ListProjectsTool,
  ListRepositoriesTool,
  CreateEpicPlanTool,
  ExecuteEpicTaskTool,
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
} from "../../../tools/epicTaskTools";
import { SendFileToUserTool } from "../../../tools/sendFileTool";
import { RunClaudeCliTool, RunCodexCliTool } from "../../../tools/runCliTools";
import { KillCliExecutionTool } from "../../../tools/killCliExecutionTool";
import { loadActiveToolSlugs } from "../../../tools/resolveAgentTools";
import getMcpTools from "../../../mcpClient";
import { instrumentFsWriteTools } from "../../../workspace/instrumentFsWriteTools";
import { drainSessionFileLedger } from "../../../workspace/sessionWorkspace";

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
    ReadSessionFileTool(agentId, threadId),
    GrepSessionFileTool(agentId, threadId),
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
    ExecuteEpicTaskTool({
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
  if (has("send_file_to_user"))
    tools.push(SendFileToUserTool(agentId));
  if (has("search_epic_tasks_by_date"))
    tools.push(SearchEpicTasksByDateTool());
  if (has("get_epic_task_stages_and_tasks"))
    tools.push(GetEpicTaskStagesAndTasksTool());
  if (has("run_claude_cli"))
    tools.push(RunClaudeCliTool(agentId, state.userId, threadId));
  if (has("run_codex_cli"))
    tools.push(RunCodexCliTool(agentId, state.userId, threadId));
  if (has("kill_cli_execution"))
    tools.push(KillCliExecutionTool(agentId, state.userId));

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
            const rawResult = await t.invoke(tc.args ?? {});
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
