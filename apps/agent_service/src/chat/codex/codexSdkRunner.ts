/**
 * OpenAI Codex SDK runtime for one LangGraph turn.
 *
 * Mirror of `agentSdkRunner.ts` for the `openai` vendor. Routes through
 * `@openai/codex-sdk` (which spawns the bundled `codex` CLI under the
 * hood) instead of the legacy `bindTools` loop, exposing the caller's
 * `StructuredToolInterface[]` to the Codex CLI via the `mcp_server`
 * bridge container.
 *
 * Dataflow per turn
 * -----------------
 *   1. Resolve `Thread.codexThreadId` (read from state, fall back to
 *      DB). Null on first turn or post-summarization.
 *   2. Mint a per-turn registry id + JWT (`mintTurnToken`) carrying the
 *      `(agentId, userId, threadId, source, allowedToolNames)` claims.
 *   3. Stash the live `tools[]` (with closures) and the optional
 *      `onToolResult` observer in the in-process tool registry, keyed
 *      by the registry id. The bridge calls `/internal/tools/*` on
 *      `agent_service`; that controller looks up the entry and invokes
 *      the tool in-process — closures intact.
 *   4. Construct a `Codex` client with the org-scoped credential and
 *      the bridge URL + bearer token wired into `config.mcp_servers`.
 *   5. `codex.startThread(...)` or `codex.resumeThread(id, ...)` →
 *      `thread.runStreamed(prompt)` → drain the iterator, collect
 *      assistant + tool_call + tool_result events into an in-order
 *      LangChain message stream.
 *   6. Persist `thread.id` back to `threads.codex_thread_id` and
 *      release the registry entry.
 *
 * System prompts
 * --------------
 * Codex SDK has no `systemPrompt` option (the API only accepts
 * `string | UserInput[]`). We prepend the rendered system prompt to
 * the user input with a markdown delimiter — same trick already used
 * by `codexAdapter.buildArgs` on the CLI tool path.
 *
 * Sub-agents
 * ----------
 * The Anthropic runner exposes a `Task("<system-agent-slug>", …)`
 * shortcut for inline sub-agent invocation. Codex SDK has no
 * equivalent; system-agent delegation continues to flow through the
 * existing async `delegate_to_deep_agent` tool. No regression — that
 * tool is vendor-agnostic and is registered on the same `tools[]` the
 * runner receives.
 */

import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type {
  Codex as CodexClass,
  CodexOptions,
  ItemCompletedEvent,
  Thread as CodexThread,
  ThreadOptions,
  TurnCompletedEvent,
  TurnFailedEvent,
} from "@openai/codex-sdk";

import { Thread } from "@scheduling-agent/database";

import { loadCodexSdk } from "./codexSdkLoader";
import {
  mintTurnToken,
  newRegistryId,
  type TurnSource,
} from "./codexBridgeAuth";
import {
  register as registerTools,
  release as releaseTools,
  type ToolResultObserver,
} from "../toolRegistry";
import type { AgentState } from "../../state";
import { logger } from "../../logger";
import type { ResolvedOrgVendor } from "../../utils/resolveOrgVendor.service";
import { drainSessionFileLedger } from "../../workspace/sessionWorkspace";
import { getAgentSdkCapabilities } from "../../utils/sdkCapabilities.service";
import {
  observeWithContext,
  recordSdkGeneration,
  recordSdkToolCall,
  updateActiveObservation,
} from "../../langfuse";
import {
  loadCodexAuthObjectForAgentWithOrg,
  materialiseCodexHome,
} from "../../utils/codexAuthJson.service";

const AGENT_HOME = "/home/agent";

/**
 * Logical name the bridge MCP server is registered under in Codex's
 * config. Tool names the model sees become `agent_tools.<tool_name>`
 * — Codex's CLI doesn't enforce a `mcp__<server>__` prefix the way the
 * Claude SDK does, so the namespace stays clean.
 */
const BRIDGE_SERVER_NAME = "agent_tools";

/**
 * Absolute path to the compiled stdio-bridge entry point Codex spawns
 * for each turn. Resolved at import time so the runner is robust to a
 * cwd change between spawn and exec — `.` paths in the config-toml
 * override would resolve under Codex's working directory, which is the
 * agent's per-session workspace, not `/app`.
 *
 * Override via `MCP_STDIO_BRIDGE_PATH` for local dev where the path may
 * differ (e.g. running ts-node directly).
 */
const STDIO_BRIDGE_PATH =
  process.env.MCP_STDIO_BRIDGE_PATH ??
  "/app/apps/agent_service/dist/chat/codex/stdioToolsBridge.js";

export interface CodexRunnerOptions {
  state: AgentState;
  config: RunnableConfig;
  tools: StructuredToolInterface[];
  vendor: ResolvedOrgVendor;
  modelSlug: string;
  /** Used purely for log context — Codex SDK has no maxTurns knob. */
  maxTurns: number;
  source: TurnSource;
  /** Optional observer fired after every successful tool result (epic
   *  graph uses it to spot the EPIC_CONTINUATION marker). */
  onToolResult?: ToolResultObserver;
}

/**
 * Pulls the latest human input out of the LangGraph state. Mirrors
 * `extractLatestUserText` in `agentSdkRunner.ts:138`.
 */
function extractLatestUserText(messages: BaseMessage[] | undefined): string | null {
  if (!messages || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as unknown as {
      _getType?: () => string;
      role?: string;
      content?: unknown;
    };
    const t =
      typeof m._getType === "function" ? m._getType() : (m.role ?? null);
    if (t === "human" || t === "user") {
      const c = m.content;
      if (typeof c === "string" && c.length > 0) return c;
      if (Array.isArray(c)) {
        const text = c
          .map((part) => {
            if (typeof part === "string") return part;
            if (part && typeof part === "object") {
              const p = part as Record<string, unknown>;
              if (typeof p.text === "string") return p.text;
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
        if (text.length > 0) return text;
      }
    }
  }
  return null;
}

async function loadCodexThreadId(
  threadId: string | null | undefined,
): Promise<string | null> {
  if (!threadId) return null;
  try {
    const row = await Thread.findByPk(threadId, {
      attributes: ["codexThreadId"],
    });
    return row?.codexThreadId ?? null;
  } catch (err) {
    logger.warn("Failed to load codexThreadId, treating as fresh thread", {
      threadId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function saveCodexThreadId(
  threadId: string | null | undefined,
  codexId: string | null,
): Promise<void> {
  if (!threadId || !codexId) return;
  try {
    await Thread.update(
      { codexThreadId: codexId },
      { where: { id: threadId } },
    );
  } catch (err) {
    logger.warn("Failed to persist codexThreadId", {
      threadId,
      codexId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Builds the env that gets handed to the Codex CLI subprocess.
 *
 * Defense-in-depth scrub: a deployment-level `OPENAI_API_KEY` or
 * `CODEX_API_KEY` would otherwise override the per-org credential the
 * SDK is supposed to use, leaking cross-tenant billing. We delete both
 * before injecting the resolved value, matching the pattern in
 * `agentSdkRunner.buildSdkEnv`.
 *
 * `HOME = /home/agent` keeps `~/.codex/sessions` on the persistent
 * named volume even though the parent process runs as root.
 *
 * The Codex SDK *also* injects `CODEX_API_KEY` automatically when an
 * `apiKey` is passed to the constructor — explicit `env` is intended
 * to be the FULL env (replaces process.env). We supply both so neither
 * inheritance nor SDK-side injection can clobber our scrubbed view.
 */
function buildCodexEnv(args: {
  /** Per-org OpenAI API key. Null when the org uses an `auth_object`
   *  credential instead — in that case OPENAI_API_KEY is left UNSET so
   *  the Codex CLI falls through to reading `auth.json` from $HOME. */
  apiKey: string | null;
  /** Per-turn temp $HOME. When the org has a Codex auth.json blob,
   *  we materialise it here and point the spawned CLI at this dir.
   *  When null, fall back to the default agent home (which has no
   *  per-org auth.json on disk — the simple-string apiKey path
   *  applies). */
  homeDir: string | null;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;

  // Critical for the auth_object path: OPENAI_API_KEY env beats the
  // CLI's auth.json lookup, so when the org's credential is the
  // auth_object blob we must NOT set OPENAI_API_KEY here. Otherwise
  // Codex would happily use the env var and ignore our materialised
  // auth.json (and we'd silently mis-bill).
  if (args.apiKey) {
    env.OPENAI_API_KEY = args.apiKey;
    env.CODEX_API_KEY = args.apiKey;
  }
  env.HOME = args.homeDir ?? AGENT_HOME;

  if (process.env.MERIDIAN_URL) {
    env.OPENAI_BASE_URL = process.env.MERIDIAN_URL;
  }
  return env;
}

interface CodexInvokeResult {
  threadId: string | null;
  finalText: string;
  /** True when the SDK reported the resume target was unknown / expired. */
  resumeFailed: boolean;
  errorText: string | null;
  /** Full intermediate transcript for this turn rendered as LangChain
   *  messages, in the order Codex emitted the underlying events. */
  streamMessages: BaseMessage[];
}

/**
 * Best-effort extraction of the text payload from an MCP tool_call
 * item's `result.content` array. Codex uses MCP `ContentBlock` shapes
 * which we already produce on the bridge side as `{type:"text", text}`.
 *
 * Typed as `unknown` rather than the SDK's structured shape because
 * the SDK's `McpToolCallItem.result.content: ContentBlock[]` includes
 * non-text variants (image / audio) we don't surface today; flattening
 * happens defensively here.
 */
function extractToolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as { content?: unknown };
  if (!Array.isArray(r.content)) return "";
  const parts: string[] = [];
  for (const block of r.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/**
 * Translates one Codex `item.completed` event into zero, one, or two
 * LangChain messages, mirroring the legacy `bindTools` loop output:
 *   - `agent_message` → AIMessage(text)
 *   - `mcp_tool_call` (success) → AIMessage(tool_calls=[{id,name,args}]) + ToolMessage(text)
 *   - `mcp_tool_call` (failure) → AIMessage + ToolMessage("[TOOL ERROR] …")
 *   - other types are surfaced as audit-only AIMessages (so the
 *     summarizer / debugger still sees reasoning, todo lists, etc.)
 *     when they carry text, otherwise dropped.
 */
function itemToMessages(
  ev: ItemCompletedEvent,
  observer: ToolResultObserver | null,
  modelSlug: string,
): {
  messages: BaseMessage[];
  /** When the item is the final assistant answer, return its text so
   *  the runner can capture it as `finalText`. */
  finalText: string | null;
} {
  const item = ev.item;
  if (!item || typeof item !== "object") {
    return { messages: [], finalText: null };
  }

  switch (item.type) {
    case "agent_message": {
      const ai = new AIMessage({ content: item.text });
      // Langfuse: record one generation span per assistant message —
      // matches the per-LLM-call granularity the legacy ChatOpenAI
      // CallbackHandler produced.
      recordSdkGeneration({
        name: "codex_agent_message",
        model: modelSlug,
        output: item.text,
        metadata: { vendor: "openai", kind: "agent_message" },
      });
      return { messages: [ai], finalText: item.text };
    }

    case "mcp_tool_call": {
      const toolName = item.tool;
      const argsObj =
        item.arguments && typeof item.arguments === "object"
          ? (item.arguments as Record<string, unknown>)
          : {};
      const ai = new AIMessage({
        content: "",
        tool_calls: [
          {
            id: item.id,
            name: toolName,
            args: argsObj,
            type: "tool_call",
          },
        ],
      });

      let text: string;
      if (item.error) {
        text = `[TOOL ERROR] ${item.error.message}`;
      } else if (item.result) {
        text = extractToolResultText(item.result);
      } else {
        text = "";
      }
      const tm = new ToolMessage({
        content: text,
        tool_call_id: item.id,
      });

      // Langfuse: emit a tool span for each MCP tool invocation so the
      // trace shows args + result + error level — same shape the
      // CallbackHandler produced from `chain_tool_start`/`chain_tool_end`.
      recordSdkToolCall({
        name: `tool:${toolName}`,
        input: argsObj,
        output: text,
        isError: !!item.error,
        metadata: { vendor: "openai", server: item.server },
      });

      // Fire the observer with the (already-truncated) text the bridge
      // returned. In-process tool invocations also fire it (in
      // internalTools.controller.call) — wiring it here too means the
      // runner sees the marker regardless of whether the tool was
      // executed via the bridge or… well, it's always the bridge for
      // this runtime, but keeping the path symmetric with the
      // Anthropic runner's `onToolResult` makes future refactors safer.
      if (observer && !item.error) {
        let argsSummary: string;
        try {
          argsSummary = JSON.stringify(argsObj);
        } catch {
          argsSummary = "(unserializable)";
        }
        if (argsSummary.length > 400) argsSummary = argsSummary.slice(0, 400) + "…";
        try {
          observer({ toolName, text, argsSummary });
        } catch (obsErr) {
          logger.warn("Codex runner observer threw", {
            tool: toolName,
            error: obsErr instanceof Error ? obsErr.message : String(obsErr),
          });
        }
      }

      return { messages: [ai, tm], finalText: null };
    }

    case "reasoning": {
      // Reasoning summaries are non-load-bearing for downstream code
      // (the summarizer ignores them today). Surface as an AIMessage
      // tagged with `additional_kwargs.runtimePart = "reasoning"` so
      // a future debug UI can filter them in or out.
      const ai = new AIMessage({
        content: item.text,
        additional_kwargs: { runtimePart: "reasoning" },
      });
      // Langfuse: tag reasoning items with their own generation span so
      // the trace separates internal reasoning from final answers.
      recordSdkGeneration({
        name: "codex_reasoning",
        model: modelSlug,
        output: item.text,
        metadata: { vendor: "openai", kind: "reasoning" },
      });
      return { messages: [ai], finalText: null };
    }

    case "command_execution":
    case "file_change":
    case "web_search":
    case "todo_list":
      // Codex CLI's built-in tool surfaces. We don't expose these
      // (sandbox is `danger-full-access` but the model would rarely
      // choose them when MCP-bridge tools are richer). When they DO
      // appear we just log — turning them into LangChain messages
      // would conflict with the typing of `tool_calls` (no Zod schema
      // registered for them).
      logger.debug("Codex emitted built-in item — ignored in transcript", {
        type: item.type,
        id: item.id,
      });
      return { messages: [], finalText: null };

    case "error": {
      // Non-fatal item-level error. Recorded in transcript so the user
      // can see what went wrong.
      const ai = new AIMessage({
        content: `[CODEX ITEM ERROR] ${item.message}`,
      });
      return { messages: [ai], finalText: null };
    }

    default:
      return { messages: [], finalText: null };
  }
}

/**
 * Drives the Codex SDK iterator for a single user-input turn and
 * reduces the stream to the few fields the runner needs to return.
 */
async function invokeCodex(args: {
  CodexCtor: typeof CodexClass;
  codexOptions: CodexOptions;
  threadOptions: ThreadOptions;
  resume: string | null;
  prompt: string;
  observer: ToolResultObserver | null;
  modelSlug: string;
}): Promise<CodexInvokeResult> {
  let finalText = "";
  let errorText: string | null = null;
  let resumeFailed = false;
  const streamMessages: BaseMessage[] = [];

  const codex: InstanceType<typeof CodexClass> = new args.CodexCtor(
    args.codexOptions,
  );

  let thread: CodexThread;
  try {
    thread = args.resume
      ? codex.resumeThread(args.resume, args.threadOptions)
      : codex.startThread(args.threadOptions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      threadId: null,
      finalText: "",
      resumeFailed: false,
      errorText: msg,
      streamMessages: [],
    };
  }

  let captured: string | null = null;
  try {
    const { events } = await thread.runStreamed(args.prompt);
    for await (const ev of events) {
      switch (ev.type) {
        case "thread.started":
          captured = ev.thread_id;
          break;
        case "item.completed": {
          const { messages, finalText: ft } = itemToMessages(
            ev,
            args.observer,
            args.modelSlug,
          );
          if (messages.length > 0) streamMessages.push(...messages);
          if (ft != null) finalText = ft;
          break;
        }
        case "turn.completed": {
          // Stamp usage onto the trailing AIMessage if present, AND on
          // the active outer Langfuse span as metadata so the trace
          // shows aggregate per-turn token usage / cost the same way
          // the legacy ChatOpenAI CallbackHandler did via OpenAI's
          // usage callback.
          const usage = (ev as TurnCompletedEvent).usage;
          const last = [...streamMessages]
            .reverse()
            .find((m): m is AIMessage => m instanceof AIMessage);
          if (last) {
            last.additional_kwargs = {
              ...(last.additional_kwargs ?? {}),
              codexUsage: usage,
            };
          }
          try {
            if (usage && typeof usage === "object") {
              updateActiveObservation({
                metadata: { usage: usage as Record<string, unknown> },
              });
            }
          } catch {
            /* tracing must not break the runner */
          }
          break;
        }
        case "turn.failed": {
          const failed = ev as TurnFailedEvent;
          errorText = failed.error?.message ?? "Codex turn failed";
          break;
        }
        case "error":
          errorText = ev.message ?? "Codex stream error";
          break;
        default:
          // turn.started, item.started, item.updated — informational only.
          break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorText = msg;
    if (
      args.resume &&
      /resume|thread.*not.*found|unknown.*thread|invalid.*thread|session.*not.*found/i.test(
        msg,
      )
    ) {
      resumeFailed = true;
    }
  }

  // Codex exposes the live thread id immediately on the Thread
  // instance once the first event has been received. Prefer that over
  // the captured value when both are present (they should agree).
  const threadId = thread.id ?? captured;

  return {
    threadId,
    finalText,
    resumeFailed,
    errorText,
    streamMessages,
  };
}

/**
 * Runs one turn through the Codex SDK and returns a state patch
 * suitable to return directly from a LangGraph node.
 *
 * Side effects:
 *   - Reads `Thread.codexThreadId` once (or uses `state.codexThreadId`).
 *   - Writes `Thread.codexThreadId` once if a new id appears.
 *   - Drains the per-thread session-file ledger.
 *   - Registers + releases the per-turn tool registry entry.
 *
 * Never throws — error paths return `Partial<AgentState>` with
 * `state.error` set, matching the legacy node contract.
 */
export async function runOpenAiCodexSdk(
  opts: CodexRunnerOptions,
): Promise<Partial<AgentState>> {
  // Trace input carries the full system + user message pair so Langfuse
  // renders the prompt as a chat exchange. Note: Codex's runner prepends
  // `# System\n…\n\n# Task\n…` into a single string before sending to
  // the SDK (Codex has no separate systemPrompt option), but for the
  // trace we keep them as two distinct messages — that's how a human
  // reading the trace expects to see them, and matches the Anthropic
  // runner's shape so cross-vendor traces are uniform.
  const userInput = extractLatestUserText(opts.state.messages) ?? "";
  const systemPrompt = opts.state.systemPrompt ?? "";
  return observeWithContext(
    "codex_sdk_turn",
    () => runOpenAiCodexSdkImpl(opts),
    {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userInput },
      ],
      model: opts.modelSlug,
      vendor: opts.vendor.vendorSlug,
      source: opts.source,
      threadId: opts.state.threadId ?? null,
      agentId: opts.state.agentId ?? null,
      userId: typeof opts.state.userId === "number" ? opts.state.userId : null,
      maxTurns: opts.maxTurns,
      toolCount: opts.tools.length,
    },
  );
}

async function runOpenAiCodexSdkImpl(
  opts: CodexRunnerOptions,
): Promise<Partial<AgentState>> {
  const { state, tools, vendor, modelSlug, source, onToolResult } = opts;
  const { systemPrompt, threadId, agentId, userId, sessionWorkspacePath } = state;

  const userInput = extractLatestUserText(state.messages);
  if (!userInput) {
    logger.warn("Codex runner: no user input found in state.messages", {
      threadId,
      source,
    });
    return { error: "No user input to process this turn." };
  }
  if (!systemPrompt) {
    return {
      error: "No system prompt assembled. Context builder may have failed.",
    };
  }
  // Either a simple-string `api_key` or a structured `auth_object` is
  // sufficient. The auth_object lookup happens later (it requires
  // `agentId` to resolve the org); if the org has neither, the runner
  // surfaces a clear error then. Empty `vendor.apiKey` is no longer a
  // hard fail at this stage.

  const existingThreadId =
    state.codexThreadId ?? (await loadCodexThreadId(threadId));

  // ── Sandbox / shell gating ─────────────────────────────────────────────
  // Codex SDK has no per-tool allowlist (its surface is mode-driven), so
  // the `bash` SDK capability translates to a sandbox-mode pick rather
  // than a tool-name allowlist:
  //   - bash attached → `danger-full-access` (full shell, no workspace
  //                     constraint, no network limit). Matches the
  //                     `--dangerously-bypass-approvals-and-sandbox` flag
  //                     the `run_codex_cli` tool already passes.
  //   - bash NOT attached → `workspace-write` (file ops within cwd only,
  //                     network constrained, shell still technically
  //                     reachable but bounded by the sandbox so a stray
  //                     command can't leave the workspace). Closest
  //                     analogue to Anthropic's "Bash off" — not strict
  //                     tool removal, but the runtime envelope the Codex
  //                     SDK exposes.
  //
  // Backfilled from the legacy `allow_sdk_bash` column by migration 145.
  // Helper applies its own conservative deny-by-default on lookup failure.
  const codexCaps = await getAgentSdkCapabilities(agentId ?? null);
  const allowBash = codexCaps.hasBash;
  const sandboxMode: "workspace-write" | "danger-full-access" = allowBash
    ? "danger-full-access"
    : "workspace-write";

  // Build the per-turn registry id + JWT.
  const registryId = newRegistryId();
  const allowedToolNames = tools.map((t) => t.name);
  const { token } = mintTurnToken({
    registryId,
    agentId: agentId ?? null,
    userId: typeof userId === "number" ? userId : null,
    threadId: threadId ?? null,
    groupId: state.groupId ?? null,
    singleChatId: state.singleChatId ?? null,
    source,
    allowedToolNames,
  });

  registerTools({
    registryId,
    tools,
    observer: onToolResult ?? null,
    context: {
      agentId: agentId ?? null,
      userId: typeof userId === "number" ? userId : null,
      threadId: threadId ?? null,
      source,
    },
  });

  // Codex auth materialisation. Two paths:
  //   - When the org has an `auth_object` row (ChatGPT-account login),
  //     materialise the blob to a persistent per-org $HOME's
  //     `.codex/auth.json` and point the spawned CLI there via env.HOME.
  //     We do NOT set OPENAI_API_KEY (the CLI's env-first lookup would
  //     otherwise win over our auth.json). Keeping the $HOME stable per
  //     org lets Codex resume the persisted `Thread.codexThreadId` because
  //     its local rollout/session cache survives across turns.
  //   - When the org only has a plain `api_key`, point HOME at the
  //     default agent home and inject OPENAI_API_KEY normally.
  const codexAuth = await loadCodexAuthObjectForAgentWithOrg(agentId);
  const codexAuthObject = codexAuth?.authObject ?? null;
  const materialised = codexAuthObject
    ? await materialiseCodexHome(codexAuthObject, {
        organizationId: codexAuth?.organizationId ?? null,
      })
    : null;
  // When using an auth_object, prefer it over the simple-string apiKey
  // (the auth_object path is the ChatGPT-account billing route the
  // admin explicitly opted into). When no auth_object exists, fall
  // back to the simple-string apiKey from `resolveOrgVendor`.
  const effectiveApiKey = materialised ? null : (vendor.apiKey ?? null);
  const effectiveHome = materialised ? materialised.homeDir : null;

  // If neither credential is available, fail fast with a clear error.
  if (!effectiveApiKey && !materialised) {
    releaseTools(registryId);
    return {
      error:
        `Your organization has not configured a Codex credential for ${vendor.vendorSlug}. ` +
        `Set either an OpenAI API key or paste the Codex CLI auth.json in Admin → Credentials.`,
    };
  }

  try {
    const sdk = await loadCodexSdk();

    // System prompt is prepended to the user input (Codex SDK has no
    // dedicated systemPrompt option). Same delimiter convention the
    // codexAdapter CLI tool already uses on the run_codex_cli path.
    const prompt = `# System\n${systemPrompt}\n\n# Task\n${userInput}`;

    const codexOptions: CodexOptions = {
      // The SDK's `apiKey` constructor option triggers internal env
      // injection if non-null. Pass it ONLY when we're on the
      // simple-key path; on the auth_object path we leave it
      // undefined so the SDK doesn't add a stale OPENAI_API_KEY back
      // into the env we just sanitised.
      ...(effectiveApiKey ? { apiKey: effectiveApiKey } : {}),
      env: buildCodexEnv({
        apiKey: effectiveApiKey,
        homeDir: effectiveHome,
      }),
      config: {
        mcp_servers: {
          // Stdio MCP, not streamable_http. Codex 0.128's rmcp client
          // fails to handshake against `@modelcontextprotocol/sdk`'s
          // HTTP server transport (untagged-enum deserialize blows up
          // on the `initialize` response) AND it silently drops the
          // `headers.authorization` we used to pass the bearer with —
          // so the previous URL-based wiring in `apps/mcp_server`
          // delivered zero tools to the model. Stdio transport is
          // unaffected by both bugs: Codex spawns the bridge directly,
          // we read the per-turn JWT from the env it injects, and
          // requests flow over stdin/stdout where rmcp's stdio
          // transport is well-tested.
          [BRIDGE_SERVER_NAME]: {
            command: "node",
            args: [STDIO_BRIDGE_PATH],
            env: {
              MCP_BRIDGE_JWT: token,
              // Stdio bridge talks to agent_service over loopback in
              // the same container — explicit override so a future
              // multi-process layout doesn't accidentally pick up a
              // wrong default.
              AGENT_SERVICE_URL: process.env.AGENT_SERVICE_URL ?? "http://127.0.0.1:3001",
            },
            // `required = true` forces Codex to spawn this MCP server
            // and call `tools/list` at session_init instead of lazily
            // on first model invocation. Without it Codex waits for
            // the model to ask — but the model can't ask for tools it
            // doesn't know exist, so the bridge never gets reached.
            // Per-server documented field (developers.openai.com/codex/
            // config-reference): "Fail startup if server can't
            // initialize" → also has the side-effect of making the
            // server's tools eagerly available to the model.
            required: true,
            // Pre-declare which tool names the bridge will return so
            // Codex's strict-mode tool-loading path doesn't drop any
            // for stale-cache reasons. This mirrors the JWT allowlist
            // exactly — the bridge's `/internal/tools/list` will only
            // return tools whose name is in `allowedToolNames`, so
            // declaring them here just keeps Codex's view consistent.
            enabled_tools: allowedToolNames,
            // Auto-approve every bridge tool call. We're running headless
            // (`approvalPolicy: "never"`), and any tool that requires
            // approval will be auto-CANCELLED with "user cancelled MCP
            // tool call" — that's exactly what was happening before this
            // line was added. Authorization for these tools already
            // happened upstream: the bridge JWT's `allowedToolNames` was
            // computed from `agent_available_tools` in `basicGraph/
            // callModel.ts`, so by the time Codex sees a tool here it's
            // already admin-approved at the database level. Asking the
            // (non-existent) human a second time is just a deadlock.
            //
            // Per the docs (github.com/openai/codex docs/config.md MCP
            // Server Approval Configuration) the per-server values are
            // `approve` (auto-approve) and `prompt` (ask the user). We
            // initially tried `"auto"` — that's the value used in the
            // top-level `apps.<id>` section, and on `mcp_servers.<id>`
            // it silently falls back to "prompt", which auto-cancels in
            // headless mode. `"approve"` is the right value here.
            default_tools_approval_mode: "approve",
          },
        },
      },
    };

    const threadOptions: ThreadOptions = {
      model: modelSlug,
      workingDirectory: sessionWorkspacePath ?? AGENT_HOME,
      // Workspaces aren't always git repos — and Codex's git check
      // would refuse to start.
      skipGitRepoCheck: true,
      // Headless server: no human to approve per-call prompts. Sandbox
      // mode is driven by `allow_sdk_bash` (see decision above).
      sandboxMode,
      approvalPolicy: "never",
    };

    logger.info("Codex SDK turn starting", {
      threadId,
      agentId,
      userId,
      source,
      modelSlug,
      vendorSlug: vendor.vendorSlug,
      toolCount: tools.length,
      resumingThread: existingThreadId != null,
      sandboxMode,
      allowBash,
    });

    let result = await invokeCodex({
      CodexCtor: sdk.Codex,
      codexOptions,
      threadOptions,
      resume: existingThreadId,
      prompt,
      observer: onToolResult ?? null,
      modelSlug,
    });

    if (result.resumeFailed) {
      logger.warn("Codex SDK resume failed — retrying with fresh thread", {
        threadId,
        previousThreadId: existingThreadId,
        error: result.errorText,
      });
      result = await invokeCodex({
        CodexCtor: sdk.Codex,
        codexOptions,
        threadOptions,
        resume: null,
        prompt,
        observer: onToolResult ?? null,
        modelSlug,
      });
    }

    if (result.threadId && result.threadId !== existingThreadId) {
      await saveCodexThreadId(threadId, result.threadId);
    }

    const sessionFiles = drainSessionFileLedger(threadId);

    if (result.errorText && !result.finalText) {
      logger.error("Codex SDK turn failed", {
        threadId,
        modelSlug,
        vendorSlug: vendor.vendorSlug,
        error: result.errorText,
      });
      return {
        error: result.errorText,
        ...(result.threadId ? { codexThreadId: result.threadId } : {}),
        ...(sessionFiles.length > 0 ? { sessionFiles } : {}),
      };
    }

    const messagesToCheckpoint: BaseMessage[] = [...result.streamMessages];
    if (messagesToCheckpoint.length === 0 && result.finalText) {
      messagesToCheckpoint.push(new AIMessage({ content: result.finalText }));
    }

    // Stamp vendor metadata on the LAST AIMessage — same convention as
    // the Anthropic runner.
    const lastAi = [...messagesToCheckpoint]
      .reverse()
      .find((m): m is AIMessage => m instanceof AIMessage);
    if (lastAi) {
      lastAi.additional_kwargs = {
        ...(lastAi.additional_kwargs ?? {}),
        modelSlug,
        vendorSlug: vendor.vendorSlug,
        modelName: vendor.modelName,
        codexThreadId: result.threadId ?? existingThreadId ?? null,
        runtime: "codex_sdk",
      };
    }

    logger.info("Codex SDK turn complete", {
      threadId,
      source,
      codexThreadId: result.threadId,
      finalTextLen: result.finalText.length,
      streamMessages: messagesToCheckpoint.length,
      sessionFiles: sessionFiles.length,
    });

    return {
      messages: messagesToCheckpoint,
      ...(result.threadId ? { codexThreadId: result.threadId } : {}),
      ...(sessionFiles.length > 0 ? { sessionFiles } : {}),
    };
  } finally {
    releaseTools(registryId);
    // Idempotent. For persistent per-org Codex homes this is a no-op; for
    // temp homes used by other call paths it wipes the materialised auth.
    if (materialised) {
      try {
        await materialised.cleanup();
      } catch {
        /* logged inside materialiseCodexHome's cleanup */
      }
    }
  }
}

/**
 * Convenience predicate for `callModelNode`s: should this turn route
 * through the Codex SDK runtime?
 *
 * Conditions:
 *   - vendor is openai, AND
 *   - `CODEX_SDK_DISABLED` env var is not truthy (kill-switch for
 *     incidents). When disabled, the legacy `bindTools` loop continues
 *     to handle the openai vendor — same shape as `shouldUseAgentSdk`.
 */
export function shouldUseCodexSdk(vendorSlug: string): boolean {
  if (vendorSlug !== "openai") return false;
  const flag = (process.env.CODEX_SDK_DISABLED ?? "").trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return false;
  return true;
}
