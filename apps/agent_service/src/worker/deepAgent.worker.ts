import crypto from "node:crypto";
import path from "node:path";
import { Worker } from "bullmq";
import {
  createDeepAgent,
  FilesystemBackend,
  CompositeBackend,
  type WriteResult,
  type EditResult,
} from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import {
  Agent,
  AgentAvailableMcpServer,
  DeepAgentDelegation,
  LLMModel,
  McpServer,
  Thread,
} from "@scheduling-agent/database";
import { resolveOrgVendorByOrg } from "../utils/resolveOrgVendor.service";
import { loadOrganizationSummarySection } from "../graphs/basicGraph/nodes/contextBuilder";
import {
  DEEP_AGENT_QUEUE_NAME,
  type DeepAgentJobData,
} from "../queues/deepAgent.bull";
import { agentChatQueue } from "../queues/agentChat.bull";
import { getMcpToolsByServerIds } from "../mcpClient";
import { systemAgentSkillTools } from "../tools/skillsTools";
import { FILESYSTEM_MCP_NAME } from "../tools/hasFilesystemMcp";
import { getLibraryPath } from "../services/library.service";
import { loadActiveToolSlugs } from "../tools/resolveAgentTools";
import { QueryDatabaseTool } from "../tools/queryDatabaseTool";
import { ConsultAgentTool } from "../tools/consultAgentTool";
import { googleTools } from "../tools/googleTools";
import { ListSystemAgentsTool } from "../tools/listSystemAgentsTool";
import { ListAgentsTool } from "../tools/listAgentsTool";
import { TavilySearchTool } from "../tools/tavilySearchTool";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogle } from "@langchain/google";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { anthropicBaseConfig } from "../chat/anthropic/anthropicContextManagement";
import { getRedisConfig } from "../redisClient";
import { getLangfuseCallbackHandler, observeWithContext, flushLangfuse } from "../langfuse";
import { logger } from "../logger";
import {
  resolveSessionWorkspacePath,
  ensureSessionWorkspace,
  recordSessionFileWrite,
  statBytes,
  isWriteAllowedExtension,
  rejectExtensionMessage,
} from "../workspace/sessionWorkspace";
import {
  ResolvedOrgVendor,
} from "../utils/resolveOrgVendor.service";
import { runAnthropicAgentSdk, shouldUseAgentSdk } from "../chat/anthropic/agentSdkRunner";
import { runOpenAiCodexSdk, shouldUseCodexSdk } from "../chat/codex/codexSdkRunner";
import {
  loadPriorPairSummaries,
  renderPriorPairSummariesBlock,
  summariseAndStorePairTurn,
} from "./deepAgentPairMemory";
import type { AgentState } from "../state";

/** Max time a deep agent invocation can run before being aborted (ms). */
const DEEP_AGENT_TIMEOUT_MS = Number(
  process.env.DEEP_AGENT_TIMEOUT_MS ?? 15 * 60 * 1000, // 15 min default
);

/** Max LangGraph node steps (prevents infinite tool loops). */
const DEEP_AGENT_RECURSION_LIMIT = Number(
  process.env.DEEP_AGENT_RECURSION_LIMIT ?? 80,
);

/** Max retries for transient failures (rate limits, network errors). */
const DEEP_AGENT_MAX_RETRIES = Number(
  process.env.DEEP_AGENT_MAX_RETRIES ?? 2,
);

/** Max characters for a deep agent result injected into caller context. */
const MAX_RESULT_CHARS = Number(
  process.env.DEEP_AGENT_MAX_RESULT_CHARS ?? 15_000,
);

/**
 * Read-only variant of `FilesystemBackend`. Used for the `/library` route of
 * the deep agent's `CompositeBackend` — `write_file` and `edit_file` return a
 * structured error instead of mutating disk, so admin-curated library docs
 * cannot be modified by executor agents.
 */
class ReadOnlyFilesystemBackend extends FilesystemBackend {
  async write(): Promise<WriteResult> {
    return { error: "This path is read-only — writes and creates are not permitted here." };
  }
  async edit(): Promise<EditResult> {
    return { error: "This path is read-only — edits are not permitted here." };
  }
}

/**
 * Variant of `FilesystemBackend` that enforces the .md/.txt write-extension
 * policy. Both `write` and `edit` reject any path whose extension isn't in
 * `ALLOWED_WRITE_EXTENSIONS` with the same friendly error string the MCP
 * wrapper uses, so the LLM gets identical feedback whichever code path it
 * happens to take.
 *
 * Used directly when the deep agent runs without a callerThreadId (no
 * per-thread folder to capture into); subclassed by
 * `InstrumentedFilesystemBackend` when manifest capture also applies.
 */
class RestrictedExtensionFilesystemBackend extends FilesystemBackend {
  async write(filePath: string, content: string): Promise<WriteResult> {
    if (!isWriteAllowedExtension(filePath)) {
      return { error: rejectExtensionMessage(filePath) };
    }
    return super.write(filePath, content);
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    if (!isWriteAllowedExtension(filePath)) {
      return { error: rejectExtensionMessage(filePath) };
    }
    return super.edit(filePath, oldString, newString, replaceAll);
  }
}

/**
 * Variant of `RestrictedExtensionFilesystemBackend` that ALSO captures
 * successful writes inside the caller's per-thread session workspace into
 * the same per-thread ledger that the basic / epic / roundtable graphs use
 * (see `workspace/sessionWorkspace.ts`).
 *
 * Writes outside the per-thread folder pass through silently — the deep agent
 * still owns the whole caller workspace (it needs to read existing artifacts
 * at the root), but only writes inside `threads/<callerThreadId>/` flow into
 * the session manifest and become discoverable by future sessions via the
 * retrieval cascade. This restores the manifest-capture behaviour that
 * `instrumentFsWriteTools` provided before the merge moved deep-agent file IO
 * off MCP and onto the deepagents built-in backend.
 */
class InstrumentedFilesystemBackend extends RestrictedExtensionFilesystemBackend {
  private readonly _rootDir: string;
  private readonly _threadId: string;
  private readonly _sessionWorkspacePath: string;
  private readonly _source: string;

  constructor(options: {
    rootDir: string;
    virtualMode?: boolean;
    maxFileSizeMb?: number;
    threadId: string;
    sessionWorkspacePath: string;
    source: string;
  }) {
    super({
      rootDir: options.rootDir,
      virtualMode: options.virtualMode,
      maxFileSizeMb: options.maxFileSizeMb,
    });
    this._rootDir = options.rootDir;
    this._threadId = options.threadId;
    this._sessionWorkspacePath = options.sessionWorkspacePath;
    this._source = options.source;
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    const result = await super.write(filePath, content);
    if (!result.error) await this._maybeRecord(filePath, "write_file");
    return result;
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    const result = await super.edit(filePath, oldString, newString, replaceAll);
    if (!result.error) await this._maybeRecord(filePath, "edit_file");
    return result;
  }

  private async _maybeRecord(virtualPath: string, toolName: string): Promise<void> {
    try {
      // Deep-agent paths are virtual under rootDir (`/foo.md`, `foo.md`,
      // `/threads/abc/foo.md` all resolve to `<rootDir>/foo.md` etc.).
      // Strip a leading `/` and resolve against the real rootDir to get
      // the on-disk absolute path; then check if it's inside the per-thread
      // folder. A path outside the per-thread folder is a write the agent
      // chose to put at the workspace root — still a valid write, just not
      // tracked in the manifest.
      const cleaned = virtualPath.replace(/^\/+/, "");
      const abs = path.resolve(this._rootDir, cleaned);
      const rel = path.relative(this._sessionWorkspacePath, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return;
      const bytes = await statBytes(abs);
      recordSessionFileWrite(this._threadId, {
        path: rel.split(path.sep).join("/"),
        bytes,
        updatedAt: new Date().toISOString(),
        source: `${this._source}:${toolName}`,
      });
    } catch (err) {
      logger.warn("Deep-agent FS write instrumentation failed (non-fatal)", {
        threadId: this._threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Determines if an error is transient and worth retrying (rate limits, network).
 */
function isTransientError(err: unknown): boolean {
  if (err instanceof DeepAgentTimeoutError) return false; // timeouts are not retried
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /rate.?limit/i.test(msg) ||
    /429/i.test(msg) ||
    /503/i.test(msg) ||
    /ECONNREFUSED/i.test(msg) ||
    /ETIMEDOUT/i.test(msg) ||
    /ECONNRESET/i.test(msg) ||
    /overloaded/i.test(msg)
  );
}

/**
 * Truncates a deep agent result if it exceeds MAX_RESULT_CHARS so the caller
 * agent's context window isn't blown by a single delegation result.
 */
function truncateResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const truncated = text.slice(0, MAX_RESULT_CHARS);
  return (
    truncated +
    `\n\n[RESULT TRUNCATED — original was ${text.length.toLocaleString()} chars, showing first ${MAX_RESULT_CHARS.toLocaleString()}. ` +
    `If you need the full result, ask the user to re-run with a narrower scope.]`
  );
}

class DeepAgentTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Deep agent execution timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    this.name = "DeepAgentTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeepAgentTimeoutError(ms)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

const DEFAULT_MODEL_SLUG = "gpt-4o";

/**
 * Resolves the vendor and model slug for an executor agent. The slug
 * resolution order is unchanged:
 *   1. agent.modelId  → lookup LLMModel by PK
 *   2. agent.modelSlug → lookup LLMModel by slug
 *   3. DEFAULT_MODEL_SLUG ("gpt-4o") fallback
 *
 * Returns null when the model is unknown or the organization has no
 * key for the resolved vendor — caller logs and fails the delegation.
 *
 * Split out from `resolveModelForAgent` so the worker can decide
 * BEFORE constructing a LangChain `ChatOpenAI` / `ChatAnthropic`
 * instance whether to dispatch to one of the SDK runners (which need
 * the vendor + slug to plumb the org credential themselves) or to fall
 * back to `createDeepAgent` for vendors that don't have an SDK path.
 */
async function resolveExecutorVendorAndModel(
  executorAgent: Agent,
): Promise<{ vendor: ResolvedOrgVendor; modelSlug: string } | null> {
  let slug: string | null = null;
  if (executorAgent.modelId) {
    const byId = await LLMModel.findByPk(executorAgent.modelId, { attributes: ["slug"] });
    if (byId) slug = byId.slug;
  }
  if (!slug && executorAgent.modelSlug) slug = executorAgent.modelSlug;
  if (!slug) slug = DEFAULT_MODEL_SLUG;

  const vendor = await resolveOrgVendorByOrg(slug, executorAgent.organizationId ?? null);
  if (!vendor) {
    logger.warn("DeepAgent: model or organization not resolvable", {
      agentId: executorAgent.id,
      organizationId: executorAgent.organizationId ?? null,
      modelSlug: slug,
    });
    return null;
  }
  if (!vendor.apiKey) {
    logger.warn("DeepAgent: organization has no API key for vendor", {
      agentId: executorAgent.id,
      organizationId: executorAgent.organizationId ?? null,
      vendorSlug: vendor.vendorSlug,
    });
    return null;
  }

  logger.info("DeepAgent: vendor resolved", {
    agentId: executorAgent.id,
    resolvedSlug: slug,
    vendorSlug: vendor.vendorSlug,
  });

  return { vendor, modelSlug: slug };
}

/**
 * Builds a LangChain `BaseChatModel` for the legacy `createDeepAgent`
 * path (Google + the kill-switch fallbacks for Anthropic / OpenAI).
 * The SDK paths bypass this entirely — they consume the resolved
 * vendor directly.
 */
function buildLangChainExecutorModel(
  vendor: ResolvedOrgVendor,
  modelSlug: string,
): BaseChatModel | null {
  switch (vendor.vendorSlug) {
    case "anthropic":
      return new ChatAnthropic({
        modelName: modelSlug,
        apiKey: vendor.apiKey ?? "",
        ...(process.env.MERIDIAN_URL ? { anthropicApiUrl: process.env.MERIDIAN_URL } : {}),
        ...anthropicBaseConfig(),
      });
    case "openai":
      return new ChatOpenAI({ modelName: modelSlug, apiKey: vendor.apiKey ?? "" });
    case "google":
      return new ChatGoogle({ model: modelSlug, apiKey: vendor.apiKey ?? "" });
    default:
      return null;
  }
}

/**
 * Synthesises a minimal `AgentState` describing one deep-agent
 * delegation, for consumption by the SDK runners.
 *
 * The runners were built for graph-driven turns where most of these
 * fields come from the LangGraph annotation; here we hand-build a
 * one-turn state with:
 *   - one HumanMessage carrying the delegation request
 *   - the fully assembled system prompt (org summary + executor
 *     instructions + workspace section, built by the caller)
 *   - a fresh `threadId` (the worker's generated UUID — no `Thread`
 *     row exists, which is fine; the runner's `Thread.update` calls
 *     no-op when no row matches)
 *   - vendor session pointers cleared (no resume — every delegation
 *     starts fresh)
 *   - `sessionWorkspacePath` set to the CALLER's per-thread folder
 *     when known, so any FS-write hooks file writes there into the
 *     caller's session manifest just like the legacy
 *     `InstrumentedFilesystemBackend` did
 */
function buildExecutorState(args: {
  userId: number;
  threadId: string;
  agentId: string;
  modelSlug: string;
  systemPrompt: string;
  userInput: string;
  groupId: string | null;
  singleChatId: string | null;
  sessionWorkspacePath: string | null;
}): AgentState {
  return {
    userId: args.userId,
    threadId: args.threadId,
    groupId: args.groupId,
    singleChatId: args.singleChatId,
    agentId: args.agentId as AgentState["agentId"],
    modelSlug: args.modelSlug,
    messages: [new HumanMessage(args.userInput)],
    systemPrompt: args.systemPrompt,
    userInput: args.userInput,
    contextAssembled: true,
    needsSummarization: false,
    error: null,
    epicContinuation: null,
    sessionWorkspacePath: args.sessionWorkspacePath,
    sessionFiles: [],
    claudeSessionId: null,
    codexThreadId: null,
    roundtableId: null,
    roundtableConfig: null,
  };
}

/**
 * Pulls the final assistant text out of an SDK runner result patch.
 * Mirrors the extraction the legacy deepagents path did: walk the
 * messages tail-first and return the last AI/`assistant` content as
 * a string. Falls back to a default phrase when nothing is found —
 * same fallback message the deepagents path returned.
 */
function extractRunnerFinalText(patch: Partial<AgentState>): string {
  const msgs = (patch.messages ?? []) as unknown[];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as {
      _getType?: () => string;
      role?: string;
      content?: unknown;
    };
    const t =
      typeof m._getType === "function" ? m._getType() : (m.role ?? null);
    if (t !== "ai" && t !== "assistant") continue;
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
        .join("\n")
        .trim();
      if (text.length > 0) return text;
    }
  }
  return "The executor agent did not produce a response.";
}

export type DeepAgentWorkerHandle = {
  worker: Worker<DeepAgentJobData>;
  close: () => Promise<void>;
};

/**
 * Executor agent worker — runs specialist agents for tasks delegated by orchestrators,
 * using the `deepagents` library (built on LangGraph).
 *
 * Each delegation gets:
 * - A RANDOM thread_id (fresh context per task)
 * - A CONSTANT user_id from agents.user_id (persistent memory per agent type)
 *
 * Flow:
 * 1. Load executor agent config from DB
 * 2. Create a deep agent via createDeepAgent() with the system agent's instructions/model
 * 3. Invoke with the delegation request
 * 4. Update delegation record with result
 * 5. Enqueue delegation_result callback to re-invoke the calling agent
 */
export function startDeepAgentWorker(): DeepAgentWorkerHandle {
  const worker = new Worker<DeepAgentJobData>(
    DEEP_AGENT_QUEUE_NAME,
    async (job) => {
      const {
        delegationId,
        executorAgentId,
        request,
        callerAgentId,
        userId,
        groupId,
        singleChatId,
        callerThreadId,
      } = job.data;

      logger.info("DeepAgent: processing job", {
        delegationId,
        executorAgentId,
        callerAgentId,
        requestLen: request.length,
      });

      // Mark as running
      await DeepAgentDelegation.update(
        { status: "running" },
        { where: { id: delegationId } },
      );

      await observeWithContext(
        "deep_agent_run",
        async () => {
          try {
            // Load executor agent config
            const executorAgent = await Agent.findByPk(executorAgentId);
            if (!executorAgent) {
              throw new Error(`Executor agent ${executorAgentId} not found`);
            }

            // Resolve a fully configured LangChain model instance (with API key + proxy)
            const resolved = await resolveExecutorVendorAndModel(executorAgent);
            if (!resolved) {
              throw new Error(
                `Cannot resolve any model for executor agent "${executorAgentId}" ` +
                `(modelId=${executorAgent.modelId}, modelSlug=${executorAgent.modelSlug})`,
              );
            }
            const { vendor, modelSlug: executorModelSlug } = resolved;

            // Decide BEFORE building the LangChain client whether this
            // delegation should run through one of the SDK runners. The
            // legacy `createDeepAgent` path stays for Google (no SDK
            // alternative) and for either kill-switch (`AGENT_SDK_DISABLED`,
            // `CODEX_SDK_DISABLED`).
            const dispatchSdk: "anthropic" | "codex" | null =
              vendor.vendorSlug === "anthropic" && shouldUseAgentSdk(vendor.vendorSlug)
                ? "anthropic"
                : vendor.vendorSlug === "openai" && shouldUseCodexSdk(vendor.vendorSlug)
                  ? "codex"
                  : null;

            // Check if this agent uses Google Search grounding, Tavily search,
            // or Google Workspace (Gmail / Calendar / Drive) tools. The Google
            // Workspace tools are bound ONLY to the dedicated
            // `google_workspace_agent` system agent
            // (toolConfig.useGoogleWorkspaceTools). Durable workspace/library
            // reads and writes ride on the filesystem MCP when the executor has
            // it attached — no dedicated workspace tools are injected here.
            const tc = executorAgent.toolConfig as Record<string, unknown> | null;
            const useGoogleSearch = !!tc?.googleSearch;
            const useTavily = !!tc?.useTavily;
            const useGoogleWorkspaceTools = !!tc?.useGoogleWorkspaceTools;
            // Anthropic-hosted web search is opt-in per agent — only the
            // dedicated `web_search_anthropic` system agent carries this
            // flag. Threaded through to the SDK runner below so it can
            // add `WebSearch` to `allowedTools`. Codex SDK has no
            // equivalent hosted-search built-in so this flag is only
            // honoured on the Anthropic dispatch path.
            const useAnthropicWebSearch = !!tc?.useAnthropicWebSearch;

            // Organization-wide grounding prepended to every executor's prompt.
            const orgSummarySection = await loadOrganizationSummarySection(
              executorAgent.organizationId ?? null,
            );
            const orgSummaryBlock = orgSummarySection.trim().length > 0
              ? `${orgSummarySection.trim()}\n\n`
              : "";

            // ── Pair-scoped memory plumbing (slice 16) ─────────────────
            // Two distinct userId concerns at this layer:
            //   - `deepAgentUserId` (executor's constant `agents.user_id`)
            //     scopes EPISODIC MEMORY writes — RAG vector partitioning
            //     belongs to the executor, not the caller.
            //   - `pairScopeUserId` (caller's constant `agents.user_id`)
            //     scopes the THREAD ROW so future delegations from the
            //     same primary↔system pair can find prior rolling
            //     summaries via (threads.user_id, threads.agent_id).
            // Both default to the human `userId` only when their agent
            // record happens to be null/missing; in steady state the two
            // are different values.
            const deepAgentUserId = executorAgent.userId ?? userId;
            const callerAgent = callerAgentId
              ? await Agent.findByPk(callerAgentId, {
                  attributes: ["userId", "agentName"],
                })
              : null;
            const pairScopeUserId =
              callerAgent?.userId ?? userId;

            const threadId = crypto.randomUUID();

            // Persist the thread row with the pair-scoping userId so
            // `loadPriorPairSummaries(callerUserId, executorAgentId)` can
            // find this row's eventual summary on the next delegation.
            // Best-effort — a Thread.create failure must not block the
            // delegation; pair memory just won't accrue for this turn.
            try {
              await Thread.create({
                id: threadId,
                userId: pairScopeUserId,
                agentId: executorAgentId,
              });
            } catch (err) {
              logger.warn(
                "DeepAgent: failed to persist Thread row for pair memory",
                {
                  delegationId,
                  threadId,
                  pairScopeUserId,
                  executorAgentId,
                  error: err instanceof Error ? err.message : String(err),
                },
              );
            }

            // Pull up to K=3 prior rolling summaries for this exact
            // (caller, executor) pair. Empty array on first delegation
            // between them or when summarisation has failed every prior
            // time — the rendered block is then "" and contributes
            // nothing to the system prompt.
            const priorPairSummaries = await loadPriorPairSummaries(
              pairScopeUserId,
              executorAgentId,
            );
            const priorPairSummariesBlock = renderPriorPairSummariesBlock(
              priorPairSummaries,
            );

            let resultText: string;

            if (useGoogleSearch) {
              // ── Google Search agent: invoke the model directly with grounding ──
              // We skip createDeepAgent entirely because it binds its own built-in
              // tools to the model, which conflicts with ChatGoogle's googleSearch.
              const chatModel = buildLangChainExecutorModel(vendor, executorModelSlug);
              if (!chatModel) {
                throw new Error(
                  `Cannot build LangChain model for Google Search agent "${executorAgentId}" ` +
                  `(vendor=${vendor.vendorSlug})`,
                );
              }
              const googleModel = (chatModel as ChatGoogle).bindTools([{ googleSearch: {} }]);

              logger.info("DeepAgent: invoking Google Search agent directly", {
                delegationId,
                modelSlug: executorAgent.modelSlug,
                threadId,
              });

              const langfuseHandler = getLangfuseCallbackHandler(userId, {
                threadId,
                delegationId,
                executorAgentId,
                service: "deep_agent",
              });

              const response = await withTimeout(
                googleModel.invoke(
                  [
                    new SystemMessage(`${orgSummaryBlock}${executorAgent.instructions!}`),
                    new HumanMessage(request),
                  ],
                  langfuseHandler ? { callbacks: [langfuseHandler] } : undefined,
                ),
                DEEP_AGENT_TIMEOUT_MS,
              );

              await flushLangfuse();

              resultText =
                typeof response.content === "string"
                  ? response.content
                  : response.content
                    ? JSON.stringify(response.content)
                    : "The web search agent did not produce a response.";
            } else {
              // ── Standard deep agent path (legacy createDeepAgent + new SDK runners) ──
              // Load active MCP tools available to this executor agent.
              //
              // Filesystem-MCP filtering rules per execution path:
              //   - Legacy `createDeepAgent`: MUST filter — deepagents'
              //     virtual-FS built-ins expose `read_file` / `write_file` /
              //     `edit_file` under the same names as the filesystem MCP,
              //     which would collide and silently route writes to memory.
              //   - Anthropic SDK: filter. The SDK exposes its own native
              //     `Read`/`Write`/`Edit`/`MultiEdit`/`Glob`/`Grep` tools
              //     (force-enabled below via `forceAllowBuiltins`) with
              //     `PreToolUse`/`PostToolUse` hooks enforcing the
              //     `.md`/`.txt` extension gate and capturing writes into
              //     the per-thread session manifest. No filesystem MCP
              //     subprocess needed.
              //   - Codex SDK: KEEP filesystem MCP. The Codex SDK has no
              //     pre-tool hook surface today, so we can't enforce the
              //     extension gate on its native `apply_patch` writes;
              //     we route file IO through the MCP-wrapped tool surface
              //     (`instrumentFsWriteTools` enforces the gate per call).
              //     When Codex SDK lands `PreToolUse`-equivalent hooks,
              //     this branch can switch to its native IO too.
              const mcpLinks = await AgentAvailableMcpServer.findAll({
                where: { agentId: executorAgent.id, active: true },
                attributes: ["mcpServerId"],
              });
              const rawMcpServerIds = mcpLinks.map((l) => l.mcpServerId);
              const filterFsMcp = dispatchSdk !== "codex";
              const fsMcpRow = rawMcpServerIds.length > 0 && filterFsMcp
                ? await McpServer.findOne({
                  where: { name: FILESYSTEM_MCP_NAME },
                  attributes: ["id"],
                })
                : null;
              const mcpServerIds = fsMcpRow
                ? rawMcpServerIds.filter((id) => id !== fsMcpRow.id)
                : rawMcpServerIds;
              const mcpTools = mcpServerIds.length > 0
                ? await getMcpToolsByServerIds(mcpServerIds, `system-agent:${executorAgentId}`)
                : [];

              const skillTools = systemAgentSkillTools(executorAgent.id);

              // Caller's persistent workspace directory — the deep agent gets
              // mounted here via its filesystem backend (below). System executor
              // agents have no workspace of their own (workspace_path is NULL per
              // migration 20240101000084); they always act on the caller's
              // directory. If the caller has none, the backend falls back to the
              // default StateBackend (ephemeral in-memory) and file writes will
              // not persist.
              let callerWorkspacePath: string | null = null;
              if (callerAgentId) {
                const callerAgent = await Agent.findByPk(callerAgentId, {
                  attributes: ["id", "workspacePath"],
                });
                callerWorkspacePath = callerAgent?.workspacePath ?? null;
              }

              // Caller's per-thread session workspace folder under
              // `<callerWorkspacePath>/threads/<callerThreadId>/`. Only computed
              // when both bits are present — without them, manifest capture is
              // not possible (no scoping bucket and no thread to attribute to).
              // The folder is ensured eagerly so the deep agent can `ls
              // /threads/<id>` and find an existing place to drop files.
              const callerSessionWorkspacePath = resolveSessionWorkspacePath(
                callerWorkspacePath,
                callerThreadId ?? null,
              );
              if (callerSessionWorkspacePath) {
                try {
                  await ensureSessionWorkspace(callerSessionWorkspacePath);
                } catch (err) {
                  logger.warn("DeepAgent: failed to ensure caller session workspace", {
                    delegationId,
                    callerSessionWorkspacePath,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }

              // Load configurable tools gated by agent_available_tools (same as callModel)
              const activeSlugs = await loadActiveToolSlugs(executorAgent.id);
              const has = (slug: string) => activeSlugs.has(slug);
              const configurableTools: any[] = [];
              if (has("query_database")) configurableTools.push(QueryDatabaseTool());
              if (has("consult_agent"))
                configurableTools.push(ConsultAgentTool(executorAgent.id, userId, groupId ?? null, singleChatId ?? null));
              if (has("list_agents")) configurableTools.push(ListAgentsTool(executorAgent.id));
              if (has("list_system_agents")) configurableTools.push(ListSystemAgentsTool(executorAgent.id));

              // Google Workspace (Gmail / Calendar / Drive) tools — bound ONLY to
              // the dedicated `google_workspace_agent` system agent
              // (tool_config.useGoogleWorkspaceTools). Executor/system agents do
              // NOT own scope grants themselves; they inherit from the caller, so
              // we key the permission check to callerAgentId. If the caller lacks
              // the grant, the tool returns a deny message at invocation time.
              const googleAgentTools = useGoogleWorkspaceTools ? googleTools(callerAgentId) : [];

              // Tavily web-search tool — injected for the dedicated Tavily-backed
              // web-search system agent (toolConfig.useTavily=true). Tavily is a
              // LangChain-native tool so, unlike Brave, it does NOT come in via
              // MCP; we just add it to the tools array directly.
              const tavilyTools = useTavily ? [TavilySearchTool()] : [];

              const allTools = [
                ...mcpTools,
                ...skillTools,
                ...configurableTools,
                ...googleAgentTools,
                ...tavilyTools,
              ];

              logger.info("DeepAgent: creating agent", {
                delegationId,
                modelSlug: executorAgent.modelSlug,
                executorAgentUserId: deepAgentUserId,
                threadId,
                toolCount: allTools.length,
              });

              // Workspace + library guidance — emitted when the caller actually
              // has a workspace directory. When set, we mount a `CompositeBackend`
              // (below) whose default backend is the caller's workspace on disk,
              // plus a read-only `/library/*` route to the admin-curated org
              // library. All the deep agent's built-in file tools (`read_file` /
              // `write_file` / `edit_file` / `ls` / `grep` / `glob`) operate
              // against this backend — no virtual in-memory FS, no filesystem MCP.
              const perThreadSection = callerThreadId
                ? (
                  `\n### Per-thread session folder (\`/threads/${callerThreadId}/\`)\n` +
                  `A subfolder \`/threads/${callerThreadId}/\` exists at your workspace root for this ` +
                  `delegation's calling thread. **Write content-rich, durable artifacts (plans, briefs, large ` +
                  `analyses, research dumps) inside this folder, not at the workspace root.** Writes here are ` +
                  `captured into the caller's session manifest, summarised when the thread closes, and indexed ` +
                  `for vector retrieval — so a future session can recover them via \`recall_episodic_memory\` → ` +
                  `\`get_thread_summary\` → \`read_session_file\`. Writes elsewhere in the workspace are still ` +
                  `saved but won't appear in the per-thread manifest.\n`
                )
                : "";
              // ── Legacy / Codex-SDK workspace section ──
              // Used by:
              //   - `createDeepAgent` path (deepagents virtual FS — the
              //     CompositeBackend mounts `/library` and the caller
              //     workspace under bare paths)
              //   - Codex SDK path via filesystem MCP (the same lowercase
              //     `read_file` / `write_file` tool names; filesystem MCP
              //     is configured to root-mount the workspace so bare
              //     paths still work)
              // The Anthropic SDK path uses a parallel section below — its
              // tool names are `Read` / `Write` / `Edit` / `Glob` / `Grep`
              // and there's no virtual `/library` mount.
              const workspaceSectionLegacy = callerWorkspacePath
                ? (
                  `## Caller workspace (your sandboxed filesystem)\n` +
                  `Your file tools — \`read_file\`, \`write_file\`, \`edit_file\`, \`ls\`, \`grep\`, \`glob\` — are ` +
                  `pre-bound to the caller's workspace directory. You do NOT need (and will not be told) the on-disk ` +
                  `path of that directory; from your point of view, the workspace IS your filesystem root. Writes ` +
                  `persist across tasks; the orchestrator that delegated to you reads the same directory.\n\n` +
                  `- **Allowed file formats — writes are restricted to \`.md\` and \`.txt\` only.** Any other ` +
                  `extension (.json, .csv, .pdf, .xlsx, …) is rejected by the backend before it touches disk. ` +
                  `Render structured data as Markdown (tables, fenced code blocks, front-matter) inside a ` +
                  `\`.md\` file when you need it.\n` +
                  `- **Paths — use bare or root-relative names only**: pass \`notes.md\` or \`/notes.md\`. Both ` +
                  `resolve to the workspace root. Subdirectories work the same way: \`reports/q1.md\` or ` +
                  `\`/reports/q1.md\`.\n` +
                  `- **Never** prefix a path with anything that looks like a host directory (no \`/app/...\`, no ` +
                  `\`/home/...\`, no \`/workspaces/...\`, no \`/data/...\`). If the orchestrator's task message ` +
                  `mentions such a path, treat it as context and write/read using the bare filename relative to your ` +
                  `root. Doing otherwise will create a duplicated nested directory inside your workspace and the ` +
                  `file will not appear where the orchestrator expects.\n` +
                  `- Paths containing \`..\` are rejected.\n` +
                  `- **Orient first**: call \`ls\` on \`/\` before you start, and \`read_file\` anything that looks ` +
                  `relevant — the orchestrator or prior specialists may have left context.\n` +
                  perThreadSection +
                  `\n### Org library (\`/library/*\`, read-only)\n` +
                  `Admin-curated reference documents are mounted at the virtual path \`/library/\`. Use \`ls /library\` ` +
                  `to browse, \`read_file /library/<name>\` to read, and \`grep\` with \`path=/library\` to search. ` +
                  `Consult before answering questions about internal policies, terminology, or procedures. Writes and ` +
                  `edits under \`/library/*\` are rejected by the backend — do not attempt them.\n\n` +
                  `### Required: self-report workspace writes\n` +
                  `At the very end of your final response to the orchestrator, include a top-level section titled ` +
                  `exactly \`## Workspace writes\` listing every file you created, edited, moved, or deleted outside ` +
                  `\`/library/\`. One bullet per file (path relative to the workspace root) with a one-line summary ` +
                  `of what it contains or why you changed it. If you made no workspace changes, include the section ` +
                  `with a single bullet \`- (none)\`. The orchestrator relies on this to know what changed.\n\n`
                )
                : "";

              // ── Anthropic SDK workspace section ──
              // Used only when `dispatchSdk === "anthropic"`. The SDK
              // exposes capitalised tool names (`Read`, `Write`, `Edit`,
              // `MultiEdit`, `Glob`, `Grep`) and operates on real paths
              // under the spawned subprocess's cwd — which the runner
              // sets to the caller's workspace via `workingDirectory`.
              // The `.md`/`.txt` extension gate is enforced by the
              // `PreToolUse` hook in `agentSdkBuiltinHooks.ts`; writes
              // under the per-thread session folder are captured into
              // the manifest by the matching `PostToolUse` hook (same
              // ledger + scoping the legacy `InstrumentedFilesystemBackend`
              // produced).
              //
              // Library access (the legacy `/library/*` virtual mount) is
              // not provided on this path. If the executor needs library
              // documents, it must have a library MCP attached
              // (`agent_available_mcp_servers`) — its tools then appear
              // alongside the SDK built-ins. Otherwise this section omits
              // the library reference entirely so the model doesn't get
              // told about a surface that isn't there.
              const perThreadSectionSdk = callerThreadId
                ? (
                  `\n### Per-thread session folder (\`threads/${callerThreadId}/\`)\n` +
                  `A subfolder \`threads/${callerThreadId}/\` exists at your workspace root for this delegation's ` +
                  `calling thread. **Write content-rich, durable artifacts (plans, briefs, large analyses, research ` +
                  `dumps) inside this folder, not at the workspace root.** Writes here are captured into the caller's ` +
                  `session manifest, summarised when the thread closes, and indexed for vector retrieval. Writes ` +
                  `elsewhere in the workspace are still saved but won't appear in the per-thread manifest.\n`
                )
                : "";
              const workspaceSectionSdk = callerWorkspacePath
                ? (
                  `## Caller workspace (your filesystem)\n` +
                  `Your built-in file tools — \`Read\`, \`Write\`, \`Edit\`, \`MultiEdit\`, \`Glob\`, \`Grep\` — are ` +
                  `pre-rooted at the caller's workspace directory (your current working directory). Use bare or ` +
                  `relative paths (\`notes.md\`, \`reports/q1.md\`); they resolve under your cwd. Writes persist ` +
                  `across tasks; the orchestrator reads the same directory.\n\n` +
                  `- **Allowed file formats — writes are restricted to \`.md\` and \`.txt\` only.** Any other ` +
                  `extension (.json, .csv, .pdf, .xlsx, …) is rejected by a pre-write hook before it touches disk. ` +
                  `Render structured data as Markdown (tables, fenced code blocks, front-matter) inside a \`.md\` ` +
                  `file when you need it.\n` +
                  `- **Use relative paths**: \`notes.md\` writes at the workspace root; \`reports/q1.md\` writes ` +
                  `inside a subdir.\n` +
                  `- **Do NOT use absolute host paths** (no \`/app/...\`, no \`/home/...\`, no \`/data/...\`). If ` +
                  `the orchestrator's task message mentions such a path, treat it as context and use the bare ` +
                  `filename relative to your cwd.\n` +
                  `- **No \`..\` traversal**: the hook rejects paths that escape the workspace.\n` +
                  `- **Orient first**: run \`Glob "*"\` or \`Read\` something promising at the start — the ` +
                  `orchestrator or prior specialists may have left context.\n` +
                  perThreadSectionSdk +
                  `\n### Required: self-report workspace writes\n` +
                  `At the very end of your final response to the orchestrator, include a top-level section titled ` +
                  `exactly \`## Workspace writes\` listing every file you created, edited, moved, or deleted. One ` +
                  `bullet per file (path relative to the workspace root) with a one-line summary of what it ` +
                  `contains or why you changed it. If you made no workspace changes, include the section with a ` +
                  `single bullet \`- (none)\`. The orchestrator relies on this to know what changed.\n\n`
                )
                : "";

              // Pick the workspace section flavour for this path. Codex
              // SDK uses the legacy section because filesystem MCP exposes
              // the same lowercase tool names. Anthropic SDK uses the
              // capitalised SDK-builtin section.
              const workspaceSection =
                dispatchSdk === "anthropic" ? workspaceSectionSdk : workspaceSectionLegacy;

              const completeSystemPrompt =
                `${orgSummaryBlock}` +
                `You are ${executorAgent.agentName}, an executor agent — a specialist responsible for carrying out tasks ` +
                `delegated to you by orchestrator agents.\n\n` +
                `${executorAgent.instructions}\n\n` +
                `## Task Guidelines\n` +
                `- Break complex tasks into steps using your todo list\n` +
                `- Be thorough and detailed in your execution\n` +
                `- Use your tools (MCP servers, file operations, etc.) to gather real data and produce real results\n` +
                `- Structure your response clearly with sections\n` +
                `- Include all relevant findings, data, and reasoning\n\n` +
                // Prior-pair rolling summaries (slice 16). Empty string
                // when this is the first delegation between this caller
                // and this executor, or when prior summaries failed to
                // generate. Comes BEFORE the workspace section so the
                // model reads the "what we discussed before" context
                // before being told about its sandbox layout.
                `${priorPairSummariesBlock}` +
                `${workspaceSection}`;

              const langfuseHandler = getLangfuseCallbackHandler(userId, {
                threadId,
                delegationId,
                executorAgentId,
                service: "deep_agent",
              });

              if (dispatchSdk) {
                // ── SDK runner path (anthropic via Claude Agent SDK,
                //     openai via Codex SDK + mcp_server bridge) ───────────
                //
                // The runners are full-execution primitives — they drive
                // the SDK to a final assistant answer with their own
                // internal tool loop. We synthesise a one-turn AgentState
                // (one HumanMessage carrying the request, the assembled
                // system prompt) and let the runner take over.
                //
                // Caller-attribution semantics preserved:
                //   - sessionWorkspacePath = caller's per-thread folder
                //     so any FS-write hooks file writes there into the
                //     caller's session manifest, mirroring what
                //     `InstrumentedFilesystemBackend` did on the legacy
                //     path.
                //   - `source: "deep_agent_executor"` tags every
                //     SDK/bridge log line so the trace separates from
                //     primary agent turns.
                const executorState = buildExecutorState({
                  userId: deepAgentUserId,
                  threadId,
                  agentId: executorAgent.id,
                  modelSlug: executorModelSlug,
                  systemPrompt: completeSystemPrompt,
                  userInput: request,
                  groupId: groupId ?? null,
                  singleChatId: singleChatId ?? null,
                  sessionWorkspacePath: callerSessionWorkspacePath ?? null,
                });

                logger.info("DeepAgent: invoking via SDK runner", {
                  delegationId,
                  modelSlug: executorModelSlug,
                  vendorSlug: vendor.vendorSlug,
                  runtime: dispatchSdk,
                  threadId,
                  toolCount: allTools.length,
                });

                // SDK `maxTurns` counts model→tool round trips; legacy
                // `recursionLimit` counted LangGraph node steps (~2 per
                // round trip). Map the two so the runtime budget stays
                // comparable. Override via env when an executor needs
                // more headroom.
                const sdkMaxTurns = Number(
                  process.env.DEEP_AGENT_SDK_MAX_TURNS ??
                    Math.max(20, Math.floor(DEEP_AGENT_RECURSION_LIMIT / 2)),
                );

                const patch = await withTimeout(
                  dispatchSdk === "anthropic"
                    ? runAnthropicAgentSdk({
                        state: executorState,
                        config: langfuseHandler
                          ? { callbacks: [langfuseHandler] }
                          : {},
                        tools: allTools as any[],
                        vendor,
                        modelSlug: executorModelSlug,
                        maxTurns: sdkMaxTurns,
                        source: "deep_agent_executor",
                        useAnthropicWebSearch,
                        // SDK built-ins (Read/Write/Edit/MultiEdit/Glob/
                        // Grep) and Bash are gated by the executor agent's
                        // attachments on the `agent_sdk_capabilities`
                        // junction (slugs `filesystem` and `bash` in
                        // `sdk_capabilities`). The runner reads these via
                        // `getAgentSdkCapabilities(state.agentId)` — no
                        // separate lookup needed here. Replaces the legacy
                        // `agents.allow_sdk_builtins` / `allow_sdk_bash`
                        // boolean columns (dropped in migration 145). The
                        // PreToolUse hook still enforces the `.md`/`.txt`
                        // extension policy on every write; PostToolUse
                        // captures workspace writes into the per-thread
                        // session manifest.
                        //
                        // cwd for the spawned Claude Code subprocess.
                        // SDK file tools (Read/Write/Edit/Glob/Grep)
                        // resolve relative paths under this. Falls
                        // back to undefined (parent's cwd) when the
                        // caller has no workspace — the model's prompt
                        // was already pruned of the workspace section
                        // in that case, so it shouldn't try to write.
                        ...(callerWorkspacePath
                          ? { workingDirectory: callerWorkspacePath }
                          : {}),
                      })
                    : runOpenAiCodexSdk({
                        state: executorState,
                        config: langfuseHandler
                          ? { callbacks: [langfuseHandler] }
                          : {},
                        tools: allTools as any[],
                        vendor,
                        modelSlug: executorModelSlug,
                        maxTurns: sdkMaxTurns,
                        source: "deep_agent_executor",
                      }),
                  DEEP_AGENT_TIMEOUT_MS,
                );

                await flushLangfuse();

                if (patch.error) {
                  throw new Error(patch.error);
                }

                resultText = extractRunnerFinalText(patch);
              } else {
                // ── Legacy createDeepAgent path (Google + kill-switch fallbacks) ──
                const chatModel = buildLangChainExecutorModel(vendor, executorModelSlug);
                if (!chatModel) {
                  throw new Error(
                    `Cannot build LangChain model for executor agent "${executorAgentId}" ` +
                    `(vendor=${vendor.vendorSlug})`,
                  );
                }

                // Create the deep agent. When the caller has a workspace, mount a
                // `CompositeBackend`: the default route is a sandboxed
                // `FilesystemBackend` at the caller's workspace (virtualMode=true,
                // so `..` traversal is rejected), and `/library/*` routes to a
                // `ReadOnlyFilesystemBackend` at the org library. We deliberately
                // do NOT attach the filesystem MCP (filtered above) — its
                // `read_file` / `write_file` / `edit_file` tool names collide with
                // the deepagents built-ins, which caused writes to land in memory
                // and subsequent `get_file_info` calls to return ENOENT.
                const checkpointer = new MemorySaver();
                // When the caller passed its threadId AND has a workspace, route
                // the default filesystem through `InstrumentedFilesystemBackend` so
                // writes inside `/threads/<callerThreadId>/` flow into the
                // per-thread session manifest. Without `callerThreadId` we still
                // mount the workspace via `RestrictedExtensionFilesystemBackend`
                // so the .md/.txt write-extension policy still fires, just without
                // manifest capture.
                const defaultBackend = callerWorkspacePath
                  ? (callerThreadId && callerSessionWorkspacePath
                    ? new InstrumentedFilesystemBackend({
                      rootDir: callerWorkspacePath,
                      virtualMode: true,
                      threadId: callerThreadId,
                      sessionWorkspacePath: callerSessionWorkspacePath,
                      source: `deep_agent:${executorAgentId}`,
                    })
                    : new RestrictedExtensionFilesystemBackend({
                      rootDir: callerWorkspacePath,
                      virtualMode: true,
                    }))
                  : null;
                const backend = defaultBackend
                  ? new CompositeBackend(defaultBackend, {
                    "/library": new ReadOnlyFilesystemBackend({
                      rootDir: getLibraryPath(),
                      virtualMode: true,
                    }),
                  })
                  : undefined;
                const agent = createDeepAgent({
                  model: chatModel as any,
                  tools: allTools as any[],
                  ...(backend ? { backend } : {}),
                  systemPrompt: completeSystemPrompt,
                  checkpointer,
                });

                // Bake Langfuse callbacks into the agent via withConfig so they
                // propagate to all inner LangGraph nodes (LLM calls, tool calls, etc.).
                const tracedAgent = langfuseHandler
                  ? agent.withConfig({ callbacks: [langfuseHandler] })
                  : agent;

                const result = await withTimeout(
                  tracedAgent.invoke(
                    {
                      messages: [{ role: "user" as const, content: request }],
                    },
                    {
                      configurable: {
                        thread_id: threadId,
                        user_id: String(deepAgentUserId),
                      },
                      recursionLimit: DEEP_AGENT_RECURSION_LIMIT,
                    },
                  ),
                  DEEP_AGENT_TIMEOUT_MS,
                );

                // Flush traces before extracting result (safety net if worker crashes later)
                await flushLangfuse();

                // Extract the final response
                const messages: any[] = Array.isArray(result.messages)
                  ? result.messages
                  : [];
                const lastAi = [...messages]
                  .reverse()
                  .find(
                    (m: any) =>
                      (typeof m._getType === "function" && m._getType() === "ai") ||
                      m.role === "assistant",
                  );

                resultText =
                  typeof lastAi?.content === "string"
                    ? lastAi.content
                    : lastAi?.content
                      ? JSON.stringify(lastAi.content)
                      : "The executor agent did not produce a response.";
              }
            }

            // Mark as completed
            await DeepAgentDelegation.update(
              {
                status: "completed",
                result: resultText,
                completedAt: new Date(),
              },
              { where: { id: delegationId } },
            );

            logger.info("DeepAgent: completed", {
              delegationId,
              resultLen: resultText.length,
              threadId,
            });

            // ── Pair rolling summary (slice 16) ────────────────────────
            // Fire-and-forget: failure here must NEVER block the
            // executor's result reaching the caller. The helper itself
            // catches its own errors and logs; we still wrap the call
            // in a `.catch` for paranoid defence-in-depth. The helper
            // skips work entirely when neither vendor SDK is enabled
            // (e.g. Google executors / kill-switched paths) — those
            // don't accumulate pair memory, by design.
            void summariseAndStorePairTurn({
              threadId,
              vendor,
              modelSlug: executorModelSlug,
              request,
              resultText,
              callerUserId: pairScopeUserId,
              executorAgentId,
              executorAgentForAuth: executorAgentId,
            }).catch((err) =>
              logger.warn("DeepAgent: pair-summary task threw outside helper", {
                delegationId,
                threadId,
                error: err instanceof Error ? err.message : String(err),
              }),
            );

            // In syncMode the caller is blocking via waitUntilFinished — skip the callback.
            // Note: when the executor has filesystem MCP + a caller workspace, its
            // own final message already includes a `## Workspace writes` section
            // per the system prompt, so the caller sees what changed without a
            // server-side recorder.
            if (!job.data.syncMode) {
              const label = executorAgent.agentName || executorAgent.definition || executorAgentId;
              const callbackResult = truncateResult(resultText);
              await agentChatQueue.add("delegation_result", {
                userId,
                message:
                  `[Executor Agent Result — Delegation ${delegationId}]\n` +
                  `Executor: ${label} (${executorAgentId})\n` +
                  `Task: ${request.substring(0, 200)}${request.length > 200 ? "..." : ""}\n\n` +
                  `## Result\n${callbackResult}`,
                requestId: `delegation-${delegationId}`,
                groupId: groupId ?? null,
                singleChatId: singleChatId ?? null,
                agentId: callerAgentId,
                mentionsAgent: true,
                displayName: `system:${executorAgentId}`,
              } as any);

              logger.info("DeepAgent: enqueued delegation_result callback", {
                delegationId,
                callerAgentId,
              });
            }

            return resultText;
          } catch (err: any) {
            const isTimeout = err instanceof DeepAgentTimeoutError;
            const isRecursionLimit =
              err?.message?.includes("recursion limit") ||
              err?.message?.includes("Recursion limit");

            // Retry transient errors (rate limits, network) with exponential backoff
            const attemptsMade = (job.attemptsMade ?? 0) + 1;
            if (isTransientError(err) && attemptsMade <= DEEP_AGENT_MAX_RETRIES) {
              const backoffMs = Math.min(1000 * Math.pow(2, attemptsMade), 30_000);
              logger.warn("DeepAgent: transient error, will retry", {
                delegationId,
                executorAgentId,
                attempt: attemptsMade,
                maxRetries: DEEP_AGENT_MAX_RETRIES,
                backoffMs,
                error: err?.message,
              });
              // Re-throw to let BullMQ handle the retry with configured backoff
              throw err;
            }

            let failureReason: string;
            if (isTimeout) {
              failureReason =
                `The executor agent timed out after ${Math.round(DEEP_AGENT_TIMEOUT_MS / 1000)} seconds. ` +
                `The task may be too complex or the agent got stuck in a loop.`;
            } else if (isRecursionLimit) {
              failureReason =
                `The executor agent reached the maximum number of processing steps (${DEEP_AGENT_RECURSION_LIMIT}). ` +
                `The task may need to be broken into smaller pieces.`;
            } else {
              failureReason = err?.message ?? "Unknown error";
            }

            logger.error("DeepAgent: job failed", {
              delegationId,
              executorAgentId,
              error: failureReason,
              isTimeout,
              isRecursionLimit,
              attempt: attemptsMade,
            });

            // Mark as failed
            await DeepAgentDelegation.update(
              {
                status: "failed",
                error: failureReason,
                completedAt: new Date(),
              },
              { where: { id: delegationId } },
            );

            if (!job.data.syncMode) {
              await agentChatQueue.add("delegation_result", {
                userId,
                message:
                  `[Executor Agent Failed — Delegation ${delegationId}]\n` +
                  `Executor: ${executorAgentId}\n` +
                  `Task: ${request.substring(0, 200)}${request.length > 200 ? "..." : ""}\n\n` +
                  `## Failure\n${failureReason}\n\n` +
                  `Please inform the user about this failure and suggest alternatives ` +
                  `(e.g. breaking the task into smaller parts, trying a different approach, or retrying later).`,
                requestId: `delegation-${delegationId}`,
                groupId: groupId ?? null,
                singleChatId: singleChatId ?? null,
                agentId: callerAgentId,
                mentionsAgent: true,
                displayName: `system:${executorAgentId}`,
              } as any);
            }

            // Re-throw so syncMode callers (waitUntilFinished) see the failure.
            throw new Error(failureReason);
          }
        }, // end observeWithContext fn
        { delegationId, executorAgentId, callerAgentId, userId },
      ); // end observeWithContext
    },
    {
      connection: getRedisConfig(),
      concurrency: Number(process.env.DEEP_AGENT_WORKER_CONCURRENCY ?? "4"),
      lockDuration: Number(
        process.env.DEEP_AGENT_LOCK_DURATION_MS ?? 30 * 60 * 1000, // 30 min default
      ),
      settings: {
        backoffStrategy: (attemptsMade: number) => {
          // Exponential backoff: 2s, 4s, 8s, ... capped at 30s
          return Math.min(1000 * Math.pow(2, attemptsMade), 30_000);
        },
      },
    },
  );

  worker.on("failed", (job, err) => {
    logger.error("DeepAgent BullMQ job failed", {
      bullJobId: job?.id,
      delegationId: job?.data?.delegationId,
      error: err?.message ?? String(err),
    });
  });

  logger.info("DeepAgent worker listening", {
    queue: DEEP_AGENT_QUEUE_NAME,
    concurrency: Number(process.env.DEEP_AGENT_WORKER_CONCURRENCY ?? "4"),
  });

  return {
    worker,
    close: () => worker.close(),
  };
}
