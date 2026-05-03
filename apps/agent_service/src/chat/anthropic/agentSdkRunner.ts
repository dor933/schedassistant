/**
 * Anthropic Claude Agent SDK runtime for one LangGraph turn.
 *
 * Drop-in replacement for the manual `bindTools` + tool-loop block that the
 * legacy `callModelNode`s use, but only on the Anthropic path. Other vendors
 * (`openai`, `google`) continue through the legacy code unchanged. This is
 * the implementation of `agentsSdkMigration.md` §3-§7 and §11.
 *
 * Responsibilities:
 *   - Resolve `claudeSessionId` for this thread (read from `Thread`, may be
 *     null on first turn or post-summarization).
 *   - Wrap the caller's tool list as an in-process MCP server.
 *   - Invoke `query()` with the system prompt, latest user input, and
 *     `resume` (if a session id is available).
 *   - Drain the iterator, capture the new session id, the final assistant
 *     text, and any epic-continuation markers seen on tool results.
 *   - Persist the session id back to the `Thread` row.
 *   - Synthesize a single AIMessage carrying the final text (plus vendor
 *     metadata) and return it for LangGraph to checkpoint.
 *   - Drain the per-thread session-file ledger so writes show up in
 *     `state.sessionFiles` the same way the legacy loop already exposes them.
 *
 * Failure modes:
 *   - Resume failure (session expired / unknown to Anthropic): the runner
 *     retries the call once with `resume` cleared. Per spec §6, this is the
 *     more robust pattern — the system prompt already encodes the working
 *     summary and recent messages so a fresh session re-bootstraps cleanly.
 *   - Any other error from the SDK: surfaced as `state.error` with the
 *     vendor's text. LangGraph's existing error propagation handles the rest.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type {
  AgentDefinition,
  HookCallbackMatcher,
  HookEvent,
  McpSdkServerConfigWithInstance,
  query as queryFn,
} from "@anthropic-ai/claude-agent-sdk";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

import { Agent, Thread } from "@scheduling-agent/database";

import {
  AGENT_TOOLS_MCP_SERVER_NAME,
  buildAllowedToolsFromTools,
  createAgentToolsMcpServer,
  type ToolResultObserver,
} from "./agentSdkAdapter";
import { loadClaudeAgentSdk } from "./agentSdkLoader";
import {
  buildBuiltinWriteHooks,
  ENABLED_BUILTIN_TOOLS,
} from "./agentSdkBuiltinHooks";
import type { AgentState } from "../../state";
import { logger } from "../../logger";
import type { ResolvedOrgVendor } from "../../utils/resolveOrgVendor.service";
import { drainSessionFileLedger } from "../../workspace/sessionWorkspace";
import {
  observeWithContext,
  recordSdkGeneration,
  recordSdkToolCall,
  updateActiveObservation,
} from "../../langfuse";

const AGENT_USER = "agent";
const AGENT_HOME = "/home/agent";

/**
 * Identifies which graph is invoking the runner. Used purely for log fields
 * and for the `source` carried on FS-write instrumentation; does not change
 * any runtime behavior of the SDK call itself.
 */
export type AgentSdkSource =
  | "primary_agent"
  | "epic_orchestrator"
  | "roundtable_agent"
  | "deep_agent_executor";

/**
 * One system agent ready to be exposed as an SDK sub-agent inside the
 * primary's `query()` call. The service that builds these (see
 * `services/buildSubAgentDefinitions.service.ts`) is responsible for
 * scoping each tool factory to the sub-agent's id so per-(agentId, userId)
 * grants in `agent_user_scopes` continue to be enforced inside each tool —
 * the runner just plugs the resulting bundles into the SDK call.
 */
export interface SubAgentBundle {
  /** Slug used as the `agents` map key — what the model passes to `Task`. */
  slug: string;
  /**
   * The DB row's `agents.type`. The SDK runner refuses to activate when
   * any bundle's type is not `"claude_sub_agent"` — system / external /
   * application / primary rows belong to other runtimes (the deep-agent
   * worker, REST application invocation, etc.) and exposing them via the
   * SDK's `agents:` map would bypass those runtimes' contracts entirely.
   * Build helpers (currently `buildSubAgentDefinitions.service.ts`) MUST
   * set this to the source row's type so the guard can fire.
   */
  agentType: string;
  definition: AgentDefinition;
  /**
   * In-process MCP server config carrying the sub-agent's tools (bound to
   * the sub-agent's id). Merged into the primary `query()` call's
   * `mcpServers` map under `mcpServerName`; per-sub-agent server names keep
   * the namespaces from colliding when several sub-agents are present.
   */
  mcpServerName: string;
  mcpServer: McpSdkServerConfigWithInstance;
  /**
   * Additional external-process MCP server configs (filesystem, github,
   * etc.) that the sub-agent has attached via `agent_available_mcp_servers`.
   * Same shape the SDK expects — keyed by server name.
   */
  externalMcpServers: Record<string, unknown>;
}

export interface AgentSdkRunnerOptions {
  state: AgentState;
  config: RunnableConfig;
  tools: StructuredToolInterface[];
  vendor: ResolvedOrgVendor;
  modelSlug: string;
  /** Equivalent to the legacy `MAX_TOOL_ROUNDS` cap — passed through as
   *  `maxTurns` to Anthropic so the SDK enforces the same safety net. */
  maxTurns: number;
  source: AgentSdkSource;
  /** Optional callback invoked with each tool result text. The epic graph
   *  uses this to spot its `[EPIC_CONTINUATION]` marker without bringing
   *  any epic-specific concept into the runner. */
  onToolResult?: ToolResultObserver;
  /**
   * Optional sub-agents (system specialists) the primary may invoke via the
   * built-in `Task` tool. When present, the runner adds `Task` to
   * `allowedTools` and merges every bundle's `mcpServer` into the primary's
   * `mcpServers` map. When empty/undefined, sub-agents are not exposed and
   * the model continues to delegate via `delegate_to_deep_agent` if it has
   * that tool granted (legacy async `deepagents` flow remains intact).
   */
  subAgents?: SubAgentBundle[];
  /**
   * Optional cwd for the spawned Claude Code subprocess. Defaults to
   * the parent's `process.cwd()` (whatever Node was started with).
   * Setting it makes `Read("foo.md")` / `Write("foo.md")` etc. resolve
   * relative to this directory — the deep-agent worker uses this to
   * point the executor at the caller's workspace, replacing the
   * deepagents virtual-FS root mount.
   */
  workingDirectory?: string;
  /**
   * Adds the Claude Agent SDK's hosted `WebSearch` server tool to
   * `allowedTools` so the model can run web searches without us wiring
   * up a Tavily/Brave client. Searches are billed against the org's
   * Anthropic credential (api_key or oauth_token). Set by the deep-agent
   * worker for the dedicated `web_search_anthropic` system agent based
   * on its `tool_config.useAnthropicWebSearch` flag — orthogonal to
   * `allow_sdk_builtins` (the read/edit surface) so a search-only agent
   * can opt out of file tools while keeping search.
   */
  useAnthropicWebSearch?: boolean;
}

/**
 * Pulls the latest human input out of the LangGraph state. The full prior
 * conversation already lives inside the Anthropic session (when `resume`
 * succeeds) and inside the rebuilt `systemPrompt` (always, via the
 * contextBuilder). We only need the new user message to drive the next turn.
 *
 * Falls back to scanning from the end so that out-of-order checkpoint
 * shapes still find the most recent human turn.
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

/**
 * Reads the current `claudeSessionId` for a thread. Best-effort — a DB lookup
 * failure should not abort the turn, just produce a fresh session.
 */
async function loadClaudeSessionId(threadId: string | null | undefined): Promise<string | null> {
  if (!threadId) return null;
  try {
    const row = await Thread.findByPk(threadId, {
      attributes: ["claudeSessionId"],
    });
    return row?.claudeSessionId ?? null;
  } catch (err) {
    logger.warn("Failed to load claudeSessionId, treating as fresh session", {
      threadId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Persists a new session id back to the thread. Best-effort — if the write
 * fails we log and continue; the next turn will start fresh and bind to a new
 * session id. The application state in LangGraph remains correct either way.
 */
async function saveClaudeSessionId(
  threadId: string | null | undefined,
  sessionId: string | null,
): Promise<void> {
  if (!threadId || !sessionId) return;
  try {
    await Thread.update(
      { claudeSessionId: sessionId },
      { where: { id: threadId } },
    );
  } catch (err) {
    logger.warn("Failed to persist claudeSessionId", {
      threadId,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Wipes the persisted `claudeSessionId` for a thread so the next turn starts
 * a fresh Claude SDK session instead of resuming a poisoned one. Used when
 * `error_max_turns` fires — the resumed session would otherwise keep tripping
 * the same per-turn tool-call budget every time the user sends a message.
 */
async function clearClaudeSessionId(
  threadId: string | null | undefined,
): Promise<void> {
  if (!threadId) return;
  try {
    await Thread.update(
      { claudeSessionId: null },
      { where: { id: threadId } },
    );
  } catch (err) {
    logger.warn("Failed to clear claudeSessionId", {
      threadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Internal helper: builds the env that gets handed to the Agent SDK process.
 *
 * Per-org credential is injected here so it never touches the parent process
 * env (multi-tenant safety). The credential stored in
 * `organization_vendor_api_keys.api_key` may be either:
 *   - a Claude Code OAuth token  (prefix `sk-ant-oat…`) — produced when the
 *     org logs into Claude.ai and exports a long-lived token, OR
 *   - a classic Anthropic API key (prefix `sk-ant-api…`).
 *
 * The SDK accepts both via separate env vars:
 *   - `CLAUDE_CODE_OAUTH_TOKEN` — for OAuth tokens (Pro/Max-tier billing).
 *   - `ANTHROPIC_API_KEY`       — for API keys (pay-as-you-go billing).
 *
 * Anthropic's SDK prioritizes the OAuth token when both are set, so we MUST
 * scrub any inherited `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` from
 * `process.env` before injecting the per-org value — defense-in-depth in case
 * something in the container env (parent process, a future feature, an
 * accidental docker-compose override) sets a shared token.
 *
 * `MERIDIAN_URL`, when set, also flows through as `ANTHROPIC_BASE_URL` —
 * matches the legacy `ChatAnthropic` config that wires `anthropicApiUrl`.
 */
function buildSdkEnv(
  credential: string,
  keyType: "api_key" | "oauth_token" | null,
): Record<string, string | undefined> {
  // Spread first, then scrub: removing keys after the spread is what isolates
  // this call from any inherited values (deployment-level Claude OAuth token,
  // any ambient ANTHROPIC_API_KEY, etc.) so per-org credentials never get
  // overridden by env-leak.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const trimmed = credential.trim();
  // Honor the explicit `key_type` from the DB row. Prefix-sniff only as a
  // last-resort fallback (legacy rows with key_type=null shouldn't exist
  // after migration 120, but be defensive).
  const resolvedType: "api_key" | "oauth_token" =
    keyType ?? (trimmed.startsWith("sk-ant-api") ? "api_key" : "oauth_token");
  if (resolvedType === "api_key") {
    env.ANTHROPIC_API_KEY = trimmed;
  } else {
    env.CLAUDE_CODE_OAUTH_TOKEN = trimmed;
  }

  if (process.env.MERIDIAN_URL) {
    env.ANTHROPIC_BASE_URL = process.env.MERIDIAN_URL;
  }
  // Ensure the SDK subprocess writes sessions under /home/agent rather than
  // inheriting root's HOME from the parent container process.
  env.HOME = AGENT_HOME;
  return env;
}

/**
 * Forces the SDK's Claude Code subprocess to run as non-root `agent`.
 *
 * In our container the Node service runs as root, but Claude's bypass mode
 * (`allowDangerouslySkipPermissions`) is rejected when running as root/sudo.
 * Wrapping the SDK spawn with `su-exec agent ...` matches the non-SDK CLI
 * path and keeps session files under /home/agent.
 *
 * `workingDirectory`, when set, overrides the cwd the SDK would have
 * passed via `options.cwd`. Used by the deep-agent worker to make
 * `Read`/`Write` resolve relative to the caller's workspace instead of
 * the parent process's cwd.
 */
function makeSpawnClaudeCodeAsAgent(
  workingDirectory?: string,
): (options: SpawnOptions) => SpawnedProcess {
  return (options) =>
    nodeSpawn("su-exec", [AGENT_USER, options.command, ...options.args], {
      cwd: workingDirectory ?? options.cwd,
      env: {
        ...options.env,
        HOME: AGENT_HOME,
      },
      signal: options.signal,
      // SDK transport writes JSON-RPC commands to stdin; it must be a pipe.
      stdio: ["pipe", "pipe", "pipe"],
    }) as unknown as SpawnedProcess;
}

interface SdkInvokeResult {
  sessionId: string | null;
  finalText: string;
  /** True when an SDK error indicated the resume failed and we should retry
   *  with a fresh session. Detected by message content as the SDK does not
   *  expose a structured error code for this case today. */
  resumeFailed: boolean;
  /** True when the SDK reported the request hit the maxTurns / max-tool-rounds
   *  limit. Mirrors the legacy "Tool loop stopped after max rounds" warning. */
  hitMaxTurns: boolean;
  errorText: string | null;
  /**
   * Full intermediate transcript for this turn rendered as LangChain messages
   * (one AIMessage per SDK `assistant` event, plus matching ToolMessages for
   * each tool_result on the corresponding `user` event). Mirrors the shape
   * the legacy `bindTools` loop produced so anything downstream that walks
   * `state.messages` (audit UIs, debugging tools, the summarizer) still sees
   * the full call sequence — not just the final assistant text.
   */
  streamMessages: BaseMessage[];
}

/**
 * Strips the in-process MCP server prefix (`mcp__agent_tools__`) so the
 * tool name on the synthesized AIMessage matches what the legacy `bindTools`
 * path would produce. Anything else (including bare names or tools from
 * other servers) is returned untouched.
 */
function unprefixToolName(name: string): string {
  const prefix = `mcp__${AGENT_TOOLS_MCP_SERVER_NAME}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/**
 * Removes `signature` fields from `thinking` content blocks. Same policy as
 * the legacy loop's `stripThinkingSignatures` — saves a lot of context tokens
 * across checkpoint serialization and prevents the signature from being
 * re-sent on next turns.
 */
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

/**
 * Converts one SDK `assistant`-typed message into a LangChain AIMessage. The
 * SDK emits these whenever the model produces output — both intermediate
 * tool-calling turns and the final answer turn. We keep the rich content
 * array (with text + optional thinking parts) so downstream consumers can
 * still see reasoning. `tool_calls` is extracted from `tool_use` blocks and
 * surfaced at the top level the same way `ChatAnthropic` would.
 */
function sdkAssistantToAIMessage(
  message: unknown,
): { aiMessage: AIMessage; toolUseIds: string[] } | null {
  const m = message as Record<string, unknown> | null;
  if (!m || typeof m !== "object") return null;
  const inner = m.message as Record<string, unknown> | undefined;
  if (!inner || typeof inner !== "object") return null;
  const blocks = inner.content;
  if (!Array.isArray(blocks)) return null;

  const cleanedContent = stripThinkingSignatures(blocks);
  const toolUseIds: string[] = [];
  const toolCalls: { id: string; name: string; args: Record<string, unknown> }[] = [];

  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    if (block.type !== "tool_use") continue;
    const id = typeof block.id === "string" ? block.id : "";
    const rawName = typeof block.name === "string" ? block.name : "";
    if (!id || !rawName) continue;
    toolUseIds.push(id);
    toolCalls.push({
      id,
      name: unprefixToolName(rawName),
      args:
        block.input && typeof block.input === "object"
          ? (block.input as Record<string, unknown>)
          : {},
    });
  }

  const aiMessage = new AIMessage({
    content: cleanedContent as AIMessage["content"],
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  });
  return { aiMessage, toolUseIds };
}

/**
 * Converts one SDK `user`-typed message (which the SDK emits to relay tool
 * results back to the model) into one ToolMessage per `tool_result` block.
 * Bare-text `user` blocks are not produced for our case (the user input
 * lives in `state.messages` from upstream) so we skip them.
 */
function sdkUserToToolMessages(message: unknown): ToolMessage[] {
  const m = message as Record<string, unknown> | null;
  if (!m || typeof m !== "object") return [];
  const inner = m.message as Record<string, unknown> | undefined;
  if (!inner || typeof inner !== "object") return [];
  const blocks = inner.content;
  if (!Array.isArray(blocks)) return [];

  const out: ToolMessage[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    if (block.type !== "tool_result") continue;
    const toolUseId =
      typeof block.tool_use_id === "string" ? block.tool_use_id : "";
    let text: string;
    const c = block.content;
    if (typeof c === "string") {
      text = c;
    } else if (Array.isArray(c)) {
      // tool_result content can be an array of text/image blocks; flatten the
      // text parts and stringify the rest so the ToolMessage is plain text
      // (the legacy ToolMessage was always string-content too).
      const parts: string[] = [];
      for (const inner2 of c) {
        if (typeof inner2 === "string") {
          parts.push(inner2);
        } else if (inner2 && typeof inner2 === "object") {
          const p = inner2 as Record<string, unknown>;
          if (typeof p.text === "string") parts.push(p.text);
          else parts.push(JSON.stringify(p));
        }
      }
      text = parts.join("\n");
    } else if (c != null && typeof c === "object") {
      try {
        text = JSON.stringify(c);
      } catch {
        text = String(c);
      }
    } else {
      text = "";
    }
    out.push(new ToolMessage({ content: text, tool_call_id: toolUseId }));
  }
  return out;
}

/**
 * Drives the SDK iterator for a single user-input turn and reduces the
 * stream to the few fields the runner actually needs.
 */
async function invokeQuery(args: {
  userInput: string;
  systemPrompt: string;
  modelSlug: string;
  apiKey: string;
  resume: string | null;
  maxTurns: number;
  mcpServer: Awaited<ReturnType<typeof createAgentToolsMcpServer>>;
  allowedTools: string[];
  /** Discriminator for `apiKey`. Routes the credential to the matching SDK
   *  env var (`ANTHROPIC_API_KEY` for `'api_key'`, `CLAUDE_CODE_OAUTH_TOKEN`
   *  for `'oauth_token'`). null falls back to prefix sniffing. */
  keyType: "api_key" | "oauth_token" | null;
  /** Already-merged map of additional MCP servers (per-sub-agent in-process
   *  servers + each sub-agent's external MCP servers). Spread alongside the
   *  primary's `agent_tools` server in the final `mcpServers` config. */
  extraMcpServers: Record<string, unknown>;
  /** Already-built sub-agent map ({ slug → AgentDefinition }) ready to pass
   *  to `query({ options: { agents } })`. Empty when no sub-agents available. */
  agents: Record<string, AgentDefinition>;
  /** Already-built `hooks` map (PreToolUse/PostToolUse for built-in writes).
   *  Empty object when the agent has not opted in to built-ins. */
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Optional working directory for the spawned Claude Code subprocess.
   *  Threaded through `makeSpawnClaudeCodeAsAgent` so SDK file tools
   *  (`Read`/`Write`/`Edit`) resolve relative to it. */
  workingDirectory?: string;
}): Promise<SdkInvokeResult> {
  let sessionId: string | null = null;
  let finalText = "";
  let hitMaxTurns = false;
  let errorText: string | null = null;
  let resumeFailed = false;
  const streamMessages: BaseMessage[] = [];

  // Tracks tool_use ids → {name, args} so when the matching tool_result
  // arrives in a `user` event we can emit a Langfuse "tool" span with
  // both input and output. Cleared as each result is paired up.
  const pendingToolCalls = new Map<
    string,
    { name: string; args: unknown }
  >();

  const sdk = await loadClaudeAgentSdk();

  // Capture stderr from the spawned Claude Code process so when it exits
  // non-zero we have the actual error message (auth failure, unknown
  // model id, malformed mcp config, etc.) — without this the SDK just
  // raises `Claude Code process exited with code N` with no detail.
  const stderrLines: string[] = [];
  const onStderr = (data: string) => {
    // Buffer up to 8 KB so a chatty CLI doesn't blow up our logs.
    const trimmed = (data ?? "").toString();
    if (stderrLines.join("\n").length + trimmed.length < 8192) {
      stderrLines.push(trimmed);
    }
  };

  try {
    for await (const message of sdk.query({
      prompt: args.userInput,
      options: {
        model: args.modelSlug,
        systemPrompt: args.systemPrompt,
        maxTurns: args.maxTurns,
        mcpServers: {
          [AGENT_TOOLS_MCP_SERVER_NAME]: args.mcpServer,
          ...args.extraMcpServers,
        },
        allowedTools: args.allowedTools,
        env: buildSdkEnv(args.apiKey, args.keyType),
        spawnClaudeCodeProcess: makeSpawnClaudeCodeAsAgent(args.workingDirectory),
        stderr: onStderr,
        ...(args.resume ? { resume: args.resume } : {}),
        ...(Object.keys(args.agents).length > 0 ? { agents: args.agents } : {}),
        ...(Object.keys(args.hooks).length > 0 ? { hooks: args.hooks } : {}),
        // Headless server mode → no human to approve per-call prompts.
        //
        // `permissionMode: 'bypassPermissions'` auto-approves every tool the
        // model decides to call. The SDK requires the explicit companion flag
        // `allowDangerouslySkipPermissions: true` to opt into this mode —
        // omitting it makes the bundled CLI reject the config and exit 1
        // (surfaces as "Claude Code process exited with code 1" with no
        // detail unless `stderr` is captured).
        //
        // The "dangerously" naming is the SDK author's branding for the
        // bypass mode in general. In our setup it is NOT actually dangerous
        // because `allowedTools` above is our explicit allowlist — the model
        // can never reach a tool we haven't already vetted, regardless of
        // permission mode. Bypass mode just removes the human "y/n" gate
        // that has no human to satisfy.
        //
        // Sub-agents (set above via `agents:`) inherit this permission mode
        // from the parent's query() — and each sub-agent's `tools:` whitelist
        // independently constrains its own surface, so the inheritance is
        // safe.
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      },
    } as Parameters<typeof queryFn>[0])) {
      const msg = message as unknown as Record<string, unknown>;
      const type = typeof msg.type === "string" ? msg.type : null;

      if (type === "system") {
        // The init system message carries the session id we need to persist.
        const sid = msg.session_id;
        if (typeof sid === "string" && sid.length > 0) {
          sessionId = sid;
        }
      } else if (type === "assistant") {
        // Each assistant turn the model produces during its internal loop —
        // intermediate tool-calling turns AND the final answer. Convert to an
        // AIMessage with tool_calls extracted from `tool_use` blocks so the
        // LangGraph checkpoint mirrors the legacy `bindTools` log.
        const converted = sdkAssistantToAIMessage(msg);
        if (converted) {
          streamMessages.push(converted.aiMessage);

          // Langfuse: record one "generation" span per assistant turn —
          // matching the legacy ChatAnthropic CallbackHandler behaviour.
          // Input is omitted because the full prompt is already on the
          // outer span; per-turn input would balloon trace size with
          // duplicated history.
          recordSdkGeneration({
            name: "anthropic_assistant",
            model: args.modelSlug,
            output: converted.aiMessage.content,
            metadata: { vendor: "anthropic" },
          });

          // Track tool_use ids → args so when the matching tool_result
          // arrives in a subsequent `user` event we can emit a tool span
          // with the original input alongside the result output.
          if (converted.aiMessage.tool_calls) {
            for (const tc of converted.aiMessage.tool_calls) {
              if (tc.id) {
                pendingToolCalls.set(tc.id, { name: tc.name, args: tc.args });
              }
            }
          }
        }
      } else if (type === "user") {
        // The SDK emits `user`-typed messages to relay tool_result blocks
        // back to the model. Convert each block into its own ToolMessage so
        // the LangGraph checkpoint preserves the call/response pairing the
        // legacy loop emitted via `new ToolMessage({ tool_call_id, content })`.
        const toolMsgs = sdkUserToToolMessages(msg);
        if (toolMsgs.length > 0) {
          streamMessages.push(...toolMsgs);

          // Langfuse: pair each tool_result with its remembered tool_use
          // and emit a "tool" span. The pending map is keyed by SDK-side
          // `tool_use_id`, which equals the `tool_call_id` we stamped on
          // each ToolMessage above.
          for (const tm of toolMsgs) {
            const toolCallId = tm.tool_call_id;
            const pending = toolCallId
              ? pendingToolCalls.get(toolCallId)
              : undefined;
            if (pending) {
              recordSdkToolCall({
                name: `tool:${pending.name}`,
                input: pending.args,
                output: tm.content,
                metadata: { vendor: "anthropic" },
              });
              pendingToolCalls.delete(toolCallId);
            } else {
              // Shouldn't normally happen — log only at debug.
              logger.debug("Tool result without matching tool_use", {
                toolCallId,
              });
            }
          }
        }
      } else if (type === "result") {
        const subtype = typeof msg.subtype === "string" ? msg.subtype : null;
        if (subtype === "success" && typeof msg.result === "string") {
          finalText = msg.result;
        } else if (subtype === "error_max_turns") {
          hitMaxTurns = true;
          errorText =
            "The assistant requested too many tool calls in one turn.";
        } else {
          errorText =
            (typeof msg.result === "string" && msg.result) ||
            `Agent SDK returned non-success result: ${subtype ?? "unknown"}`;
        }
        // Stamp aggregate usage + cost as metadata on the active outer
        // span when the SDK reports them on the result event. Outer
        // span is a generic "span" (not "generation"), so we put
        // usage/cost in `metadata` rather than on the typed
        // `usageDetails` / `costDetails` fields. Per-turn usage is more
        // granular but the SDK doesn't expose it per-assistant-event
        // today; this aggregate is the best we can do without adding
        // another stream parser.
        try {
          const aggregateMeta: Record<string, unknown> = {};
          const usage = (msg as Record<string, unknown>).usage;
          if (usage && typeof usage === "object") {
            const u = usage as Record<string, unknown>;
            const usageDetails: Record<string, number> = {};
            for (const [key, value] of Object.entries(u)) {
              if (typeof value === "number" && Number.isFinite(value)) {
                usageDetails[key] = value;
              }
            }
            if (Object.keys(usageDetails).length > 0) {
              aggregateMeta.usage = usageDetails;
            }
          }
          const cost = (msg as Record<string, unknown>).total_cost_usd ??
            (msg as Record<string, unknown>).cost_usd;
          if (typeof cost === "number" && Number.isFinite(cost)) {
            aggregateMeta.totalCostUsd = cost;
          }
          if (Object.keys(aggregateMeta).length > 0) {
            updateActiveObservation({ metadata: aggregateMeta });
          }
        } catch {
          /* tracing must not break the runner */
        }
        // result message terminates the iterator — but we still let the
        // for-await loop drain naturally rather than `break`-ing early.
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // When the bundled Claude Code subprocess exits non-zero the SDK only
    // raises `Claude Code process exited with code N` with no body. The
    // actual reason (auth failure, unknown model, bad mcp config, …) was
    // written to stderr — surface it alongside the SDK's wrapper message
    // so logs are debuggable without needing to re-run with extra tracing.
    const stderrTail = stderrLines
      .join("")
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .slice(-20)
      .join("\n");
    errorText = stderrTail ? `${msg}\n[stderr]\n${stderrTail}` : msg;
    if (stderrTail) {
      logger.error("Agent SDK process stderr", { stderrTail });
    }
    // Heuristic: when the resume target is unknown or expired, surface that
    // so the caller can retry without `resume`. The SDK does not expose a
    // typed error code for this case yet, so we string-match conservatively.
    if (
      args.resume &&
      /resume|session.*not.*found|unknown.*session|invalid.*session/i.test(msg)
    ) {
      resumeFailed = true;
    }
  }

  return { sessionId, finalText, resumeFailed, hitMaxTurns, errorText, streamMessages };
}

/**
 * Runs one turn through the Claude Agent SDK and returns a state patch
 * suitable to return directly from a LangGraph node.
 *
 * Side effects:
 *   - Reads `Thread.claudeSessionId` once at the start.
 *   - Writes `Thread.claudeSessionId` once at the end (if a new id appeared).
 *   - Drains the per-thread session-file ledger (`drainSessionFileLedger`).
 *
 * The function never throws — all error paths return a `Partial<AgentState>`
 * with `state.error` set. This matches the legacy node contract.
 */
export async function runAnthropicAgentSdk(
  opts: AgentSdkRunnerOptions,
): Promise<Partial<AgentState>> {
  // Trace input intentionally carries the FULL system prompt + user
  // message as a `messages` array so Langfuse renders it as a chat
  // exchange. Per-assistant generation spans inside the runner still
  // omit input (they'd duplicate the history) — the outer span is the
  // single canonical place to see "what the model was asked".
  const userInput = extractLatestUserText(opts.state.messages) ?? "";
  const systemPrompt = opts.state.systemPrompt ?? "";
  return observeWithContext(
    "anthropic_sdk_turn",
    () => runAnthropicAgentSdkImpl(opts),
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
      hasSubAgents: !!(opts.subAgents && opts.subAgents.length > 0),
    },
  );
}

async function runAnthropicAgentSdkImpl(
  opts: AgentSdkRunnerOptions,
): Promise<Partial<AgentState>> {
  const {
    state,
    tools,
    vendor,
    modelSlug,
    maxTurns,
    source,
    onToolResult,
    subAgents,
    workingDirectory,
    useAnthropicWebSearch,
  } = opts;
  const { systemPrompt, threadId, agentId, userId, sessionWorkspacePath } = state;

  const userInput = extractLatestUserText(state.messages);
  if (!userInput) {
    logger.warn("Agent SDK runner: no user input found in state.messages", {
      threadId,
      source,
    });
    return { error: "No user input to process this turn." };
  }

  if (!systemPrompt) {
    return { error: "No system prompt assembled. Context builder may have failed." };
  }

  const existingSessionId =
    state.claudeSessionId ?? (await loadClaudeSessionId(threadId));

  // ── Built-in opt-in ────────────────────────────────────────────────────
  // Two flags on the agent row drive whether SDK built-ins / Bash are exposed:
  //   - `allow_sdk_builtins` → Read/Write/Edit/MultiEdit/Glob/Grep/WebFetch
  //                           (the read+edit surface). Migration 125
  //                           flipped the column default to TRUE and
  //                           backfilled existing Anthropic rows, so the
  //                           typical case is "always on" — admins can
  //                           still opt a specific agent OUT for an
  //                           unusual reason by toggling the row flag.
  //   - `allow_sdk_bash`     → Bash. Defaults to FALSE; admins opt in per
  //                           agent. The blast radius (arbitrary shell)
  //                           is meaningfully larger than the file-tool
  //                           surface, so the runner never auto-enables
  //                           it without the row flag.
  let allowBuiltins = false;
  let allowBash = false;
  if (agentId) {
    try {
      const agentRow = await Agent.findByPk(agentId, {
        attributes: ["allowSdkBuiltins", "allowSdkBash"],
      });
      allowBuiltins = agentRow?.allowSdkBuiltins === true;
      allowBash = agentRow?.allowSdkBash === true;
    } catch (err) {
      logger.warn("Failed to load SDK builtin flags — defaulting both to false", {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const mcpServer = await createAgentToolsMcpServer(tools, onToolResult);

  // ── Compose allowedTools list ──────────────────────────────────────────
  // Always: primary's `mcp__agent_tools__*` (the in-process MCP wrapping the
  //         existing LangChain tool factories).
  // If agent opted in: SDK built-ins from `ENABLED_BUILTIN_TOOLS`.
  // If sub-agents present: `Task` so the model can invoke them.
  // Sub-agent in-process MCP servers expose tools as
  //   `mcp__sys_<id>__<tool_name>` — we add those names too so the parent
  //   model technically *could* call them directly (Anthropic's models
  //   typically prefer the sub-agent path via Task; the listing is for
  //   completeness in case a workflow benefits from a direct call).
  const allowedTools: string[] = [
    ...buildAllowedToolsFromTools(tools),
    ...(allowBuiltins ? [...ENABLED_BUILTIN_TOOLS] : []),
    ...(allowBash ? ["Bash"] : []),
    // Anthropic-hosted `WebSearch` is opt-in and billed per search; we
    // only expose it for the dedicated `web_search_anthropic` system
    // agent (toolConfig.useAnthropicWebSearch=true), never as part of
    // the standard built-ins surface.
    ...(useAnthropicWebSearch ? ["WebSearch"] : []),
  ];
  const hasSubAgents = !!(subAgents && subAgents.length > 0);
  if (hasSubAgents) {
    // Activation guard (slice 19): the SDK's `agents:` map must contain
    // ONLY `claude_sub_agent` rows. Any other type would bypass the
    // runtime contract its row was created for — system agents must go
    // through `delegate_to_deep_agent` (worker queue), external agents
    // through the roundtable graph, application agents through the
    // REST endpoint, primary agents are top-level entry points only.
    // Throwing here fails the whole `query()` so a misconfigured
    // build-helper or future caller is caught at first invocation, not
    // by surprised model behaviour.
    const offending = subAgents!.filter(
      (sa) => sa.agentType !== "claude_sub_agent",
    );
    if (offending.length > 0) {
      const detail = offending
        .map((sa) => `${sa.slug} (type=${sa.agentType})`)
        .join(", ");
      throw new Error(
        `runAnthropicAgentSdk refuses activation: subAgents must contain only ` +
          `claude_sub_agent rows. Offending bundles: ${detail}.`,
      );
    }
    allowedTools.push("Task");
    for (const sa of subAgents!) {
      // Each sub-agent server exposes its own `mcp__<server>__*` tools; the
      // sub-agent's `tools` whitelist (built inside its AgentDefinition)
      // already constrains what *it* may call. Listing the prefix on the
      // parent's allowedTools is harmless and keeps the surface explicit.
      // The SDK matches `mcp__<server>__*` literally — wildcard suffix
      // is supported.
      allowedTools.push(`mcp__${sa.mcpServerName}__*`);
    }
  }

  // ── Compose extraMcpServers (one entry per sub-agent's in-process server,
  //     plus that sub-agent's external MCP servers). External servers are
  //     keyed by the names assigned in the DB; we trust admins not to assign
  //     conflicting names across system agents in the same org. ─────────
  const extraMcpServers: Record<string, unknown> = {};
  const agents: Record<string, AgentDefinition> = {};
  if (hasSubAgents) {
    for (const sa of subAgents!) {
      extraMcpServers[sa.mcpServerName] = sa.mcpServer;
      for (const [name, cfg] of Object.entries(sa.externalMcpServers)) {
        // Don't clobber a server name already provided by another sub-agent
        // — first writer wins; later sub-agents that need a same-named server
        // fall through to `inheritParent` semantics on their AgentDefinition.
        if (!(name in extraMcpServers)) extraMcpServers[name] = cfg;
      }
      agents[sa.slug] = sa.definition;
    }
  }

  // ── Hooks: only wire when the agent has built-ins enabled. The
  //     PreToolUse extension gate and PostToolUse session-file ledger
  //     mirror `instrumentFsWriteTools` for the SDK's native Write/Edit/
  //     MultiEdit. When built-ins are disabled the SDK won't expose those
  //     tools, so the hooks would never fire — skip registration to keep
  //     the spawned subprocess config minimal. ────────────────────────────
  const hooks = allowBuiltins
    ? buildBuiltinWriteHooks({
        threadId,
        sessionWorkspacePath,
        source,
      })
    : {};

  logger.info("Agent SDK turn starting", {
    threadId,
    agentId,
    userId,
    source,
    modelSlug,
    vendorSlug: vendor.vendorSlug,
    maxTurns,
    toolCount: tools.length,
    builtinsEnabled: allowBuiltins,
    bashEnabled: allowBash,
    subAgentCount: hasSubAgents ? subAgents!.length : 0,
    resumingSession: existingSessionId != null,
  });

  let result = await invokeQuery({
    userInput,
    systemPrompt,
    modelSlug,
    apiKey: vendor.apiKey ?? "",
    keyType: vendor.keyType,
    resume: existingSessionId,
    maxTurns,
    mcpServer,
    allowedTools,
    extraMcpServers,
    agents,
    hooks,
    workingDirectory,
  });

  // Resume failure → retry once with no resume target (spec §6).
  if (result.resumeFailed) {
    logger.warn("Agent SDK resume failed — retrying with fresh session", {
      threadId,
      previousSessionId: existingSessionId,
      error: result.errorText,
    });
    result = await invokeQuery({
      userInput,
      systemPrompt,
      modelSlug,
      apiKey: vendor.apiKey ?? "",
      keyType: vendor.keyType,
      resume: null,
      maxTurns,
      mcpServer,
      allowedTools,
      extraMcpServers,
      agents,
      hooks,
      workingDirectory,
    });
  }

  // Max-turns is a soft failure, not a hard error. The SDK ran the model's
  // tool loop until our `maxTurns` cap and bailed before the model could
  // produce final text. Two things must happen so the agent isn't stuck
  // re-tripping the same budget every subsequent message:
  //   1. Don't persist the SDK session id — resuming it next turn would
  //      restart mid-tool-loop and almost certainly hit the cap again.
  //      Clear any previously-stored value so `loadClaudeSessionId` returns
  //      null on the next turn and we get a fresh session.
  //   2. Treat the turn as a successful checkpoint: keep the partial work
  //      the model already did (`result.streamMessages`) and append a soft
  //      AIMessage telling the user we hit the cap. Returning `error`
  //      here is what was creating the per-message error loop the user
  //      reported.
  if (result.hitMaxTurns) {
    await clearClaudeSessionId(threadId);
    const sessionFilesAtCap = drainSessionFileLedger(threadId);
    const messagesAtCap: BaseMessage[] = [...result.streamMessages];
    messagesAtCap.push(
      new AIMessage({
        content:
          "I hit my per-turn tool-call budget while working on that. " +
          "Some intermediate work above may have completed. Ask me to " +
          "continue and I'll pick up from where I stopped in a fresh session.",
      }),
    );
    const lastAiAtCap = [...messagesAtCap]
      .reverse()
      .find((m): m is AIMessage => m instanceof AIMessage);
    if (lastAiAtCap) {
      lastAiAtCap.additional_kwargs = {
        ...(lastAiAtCap.additional_kwargs ?? {}),
        modelSlug,
        vendorSlug: vendor.vendorSlug,
        modelName: vendor.modelName,
        // Session is intentionally abandoned — surface that on the trace.
        claudeSessionId: null,
        runtime: "claude_agent_sdk",
        hitMaxTurns: true,
      };
    }
    logger.warn("Agent SDK turn hit maxTurns — session cleared, soft-completing", {
      threadId,
      source,
      modelSlug,
      vendorSlug: vendor.vendorSlug,
      abandonedSessionId: result.sessionId ?? existingSessionId ?? null,
      streamMessages: messagesAtCap.length,
      sessionFiles: sessionFilesAtCap.length,
    });
    return {
      messages: messagesAtCap,
      // Explicitly null in state so the next turn doesn't read a stale
      // value out of the in-memory checkpoint either.
      claudeSessionId: null,
      ...(sessionFilesAtCap.length > 0 ? { sessionFiles: sessionFilesAtCap } : {}),
    };
  }

  // Persist any new session id we got back, including the fresh one after a
  // successful retry.
  if (result.sessionId && result.sessionId !== existingSessionId) {
    await saveClaudeSessionId(threadId, result.sessionId);
  }

  const sessionFiles = drainSessionFileLedger(threadId);

  if (result.errorText && !result.finalText) {
    logger.error("Agent SDK turn failed", {
      threadId,
      modelSlug,
      vendorSlug: vendor.vendorSlug,
      error: result.errorText,
      hitMaxTurns: result.hitMaxTurns,
    });
    return {
      error: result.errorText,
      ...(result.sessionId ? { claudeSessionId: result.sessionId } : {}),
      ...(sessionFiles.length > 0 ? { sessionFiles } : {}),
    };
  }

  // Build the messages array to checkpoint. Mirrors the legacy `bindTools`
  // loop: every intermediate AIMessage (with tool_calls) and matching
  // ToolMessage(s) appear in order, ending with the final answer AIMessage.
  // Anything walking `state.messages` (audit UIs, debugging, summarizer) sees
  // the full turn — not just the final text.
  const messagesToCheckpoint: BaseMessage[] = [...result.streamMessages];

  // Defensive fallback: if the SDK produced no assistant messages at all but
  // we still have a `finalText` (older SDK shapes, custom transports), wrap
  // it in a minimal AIMessage so the turn is not silently lost.
  if (messagesToCheckpoint.length === 0 && result.finalText) {
    messagesToCheckpoint.push(new AIMessage({ content: result.finalText }));
  }

  // Stamp vendor / runtime metadata onto the LAST AIMessage in the stream —
  // matches the legacy convention where only the final response carries
  // `additional_kwargs.modelSlug` / `vendorSlug` / `modelName`.
  const lastAi = [...messagesToCheckpoint]
    .reverse()
    .find((m): m is AIMessage => m instanceof AIMessage);
  if (lastAi) {
    lastAi.additional_kwargs = {
      ...(lastAi.additional_kwargs ?? {}),
      modelSlug,
      vendorSlug: vendor.vendorSlug,
      modelName: vendor.modelName,
      claudeSessionId: result.sessionId ?? existingSessionId ?? null,
      runtime: "claude_agent_sdk",
    };
  }

  logger.info("Agent SDK turn complete", {
    threadId,
    source,
    sessionId: result.sessionId,
    finalTextLen: result.finalText.length,
    streamMessages: messagesToCheckpoint.length,
    sessionFiles: sessionFiles.length,
  });

  return {
    messages: messagesToCheckpoint,
    ...(result.sessionId ? { claudeSessionId: result.sessionId } : {}),
    ...(sessionFiles.length > 0 ? { sessionFiles } : {}),
  };
}

/**
 * Convenience predicate for `callModelNode`s: should this turn route through
 * the Agent SDK runtime?
 *
 * Conditions:
 *   - vendor is anthropic, AND
 *   - `AGENT_SDK_DISABLED` env var is not truthy (kill-switch for incidents).
 *
 * The kill-switch is intentional: it lets ops disable the SDK path globally
 * without redeploying, falling all Anthropic agents back onto the legacy
 * `bindTools` loop until the issue is resolved.
 */
export function shouldUseAgentSdk(vendorSlug: string): boolean {
  if (vendorSlug !== "anthropic") return false;
  const flag = (process.env.AGENT_SDK_DISABLED ?? "").trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return false;
  return true;
}

/**
 * Re-export so consumers don't have to import from two places. The runner is
 * the documented entry point for migrated callers.
 */
export { extractLatestUserText as _extractLatestUserTextForTesting };
/** Re-exported for tests / callers that want to stage their own HumanMessage. */
export { HumanMessage };
