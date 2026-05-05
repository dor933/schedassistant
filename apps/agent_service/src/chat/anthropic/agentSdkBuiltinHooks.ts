/**
 * Hooks that re-create the `instrumentFsWriteTools` policy on the SDK path.
 *
 * The legacy filesystem-MCP write tools (`write_file`, `edit_file`, `move_file`)
 * are wrapped by `instrumentFsWriteTools` so that:
 *   1. Writes outside the `.md` / `.txt` allowlist are rejected with a friendly
 *      message before they hit disk.
 *   2. Writes that land inside the per-thread session workspace are recorded
 *      into the `recordSessionFileWrite` ledger so they show up in the session
 *      summary's `files` manifest and become searchable via the episodic-memory
 *      cascade (`recall_episodic_memory` → `get_thread_summary` → read
 *      the listed manifest paths with built-in file tools).
 *
 * When we let the model use the SDK's built-in `Write` / `Edit` / `MultiEdit`
 * tools, those LangChain wrappers do not run — Claude Agent SDK invokes the
 * native tools directly. To keep the same policy + ledger behavior we register
 * `PreToolUse` (extension gate) and `PostToolUse` (ledger record) hooks that
 * watch the same tool names.
 *
 * Read-only built-ins (`Read`, `Glob`, `Grep`, `WebFetch`) are intentionally
 * not hooked — there is nothing to instrument for them.
 */

import path from "node:path";
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";

import { logger } from "../../logger";
import {
  isWriteAllowedExtension,
  recordSessionFileWrite,
  rejectExtensionMessage,
  statBytes,
} from "../../workspace/sessionWorkspace";

/**
 * Regex matcher matched by the SDK against `tool_name`. The SDK applies this
 * regex per-event so we only intercept the three built-in write tools — every
 * other tool (Read, Grep, Glob, WebFetch, MCP tools, sub-agent Task) flows
 * through untouched.
 */
const WRITE_TOOL_MATCHER = "Write|Edit|MultiEdit";

export interface BuiltinHooksContext {
  /** The thread whose ledger should receive recorded writes. May be null
   *  when the agent has no workspace, in which case the PostToolUse hook
   *  short-circuits and the PreToolUse extension gate still fires. */
  threadId: string | null | undefined;
  /** Absolute path to the per-thread session workspace folder. Same field
   *  used by `instrumentFsWriteTools.ctx.sessionWorkspacePath` — writes
   *  outside this directory are not recorded. */
  sessionWorkspacePath: string | null | undefined;
  /** Provenance tag attached to ledger entries (e.g. "primary_agent",
   *  "epic_orchestrator"). Mirrors the legacy convention. */
  source: string;
}

/**
 * Pulls the destination path out of a built-in write tool's `tool_input`. All
 * three tools (`Write`, `Edit`, `MultiEdit`) use `file_path: string` as the
 * canonical field — Anthropic's published tool schemas. Returns null for any
 * shape we don't recognize so the gate fails open (the underlying tool will
 * still validate arguments and reject if they're malformed).
 */
function extractFilePath(toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const inp = toolInput as Record<string, unknown>;
  return typeof inp.file_path === "string" ? inp.file_path : null;
}

/**
 * PreToolUse hook: enforces the `.md` / `.txt` extension gate on built-in
 * Write/Edit/MultiEdit. Returns `permissionDecision: 'deny'` with the same
 * `rejectExtensionMessage(...)` text the legacy wrapper produces, so the
 * model gets a consistent error and can retry with a valid extension.
 *
 * The policy is intentionally identical to the FS-MCP wrapper — switching
 * tool surfaces (built-in vs MCP) must not change what the agent is allowed
 * to write.
 */
function buildExtensionGateHook(): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {} as HookJSONOutput;
    const filePath = extractFilePath(input.tool_input);
    if (!filePath) return {} as HookJSONOutput;
    if (isWriteAllowedExtension(filePath)) return {} as HookJSONOutput;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: rejectExtensionMessage(filePath),
      },
    };
  };
}

/**
 * PostToolUse hook: records successful built-in write calls inside the
 * per-thread session workspace into the in-memory ledger. The SDK only fires
 * `PostToolUse` (not `PostToolUseFailure`) on success, so failures are not
 * recorded — same semantics as the legacy `wrapWriteTool` which only records
 * after the underlying tool's `invoke` resolves.
 *
 * Path resolution is absolute-or-relative-to-workspace (matches
 * `maybeRecordWrite` in `instrumentFsWriteTools.ts`). Writes outside the
 * workspace silently no-op; the ledger only owns per-thread session files.
 */
function buildRecordWriteHook(ctx: BuiltinHooksContext): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PostToolUse") return {} as HookJSONOutput;
    const { threadId, sessionWorkspacePath, source } = ctx;
    if (!threadId || !sessionWorkspacePath) return {} as HookJSONOutput;

    const filePath = extractFilePath(input.tool_input);
    if (!filePath) return {} as HookJSONOutput;

    try {
      const root = path.resolve(sessionWorkspacePath);
      const abs = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(root, filePath);
      const rel = path.relative(root, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        // Write landed outside the session workspace — not ours to track.
        return {} as HookJSONOutput;
      }

      const bytes = await statBytes(abs);
      recordSessionFileWrite(threadId, {
        path: rel.split(path.sep).join("/"),
        bytes,
        updatedAt: new Date().toISOString(),
        source: `${source}:${input.tool_name}`,
      });
    } catch (err) {
      // Same posture as the legacy wrapper: never propagate ledger errors
      // back to the model. The disk write already succeeded; only manifest
      // capture is best-effort.
      logger.warn("Agent SDK PostToolUse write-record hook failed (non-fatal)", {
        tool: input.tool_name,
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return {} as HookJSONOutput;
  };
}

/**
 * Returns the `hooks` map ready to be spread into `query({ options })`. Empty
 * when callers don't actually need the gate (e.g. an agent without
 * `allow_sdk_builtins` — the SDK won't expose those tools to the model
 * anyway, so registering hooks for them would just be noise).
 */
export function buildBuiltinWriteHooks(
  ctx: BuiltinHooksContext,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [
      { matcher: WRITE_TOOL_MATCHER, hooks: [buildExtensionGateHook()] },
    ],
    PostToolUse: [
      { matcher: WRITE_TOOL_MATCHER, hooks: [buildRecordWriteHook(ctx)] },
    ],
  };
}

/**
 * The full set of built-in tool names we expose when an agent has
 * `allow_sdk_builtins = true`. These cover read, search, write, and web
 * fetch — the everyday surface a developer-style agent benefits from.
 *
 * Intentionally NOT included by default:
 *   - `Bash` — too broad; `RunClaudeCliTool` / `RunCodexCliTool` already
 *     give us sandboxed CLI access via existing `agent_available_tools`.
 *   - `Task` — gated by sub-agent presence; added separately by the runner
 *     when the `agents` map is populated.
 *   - `TodoWrite` — could be added later as a separate opt-in if useful;
 *     for now the model's existing planning behavior is unchanged.
 *   - `NotebookEdit`, image tools, etc. — out of scope for this codebase.
 */
export const ENABLED_BUILTIN_TOOLS: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "MultiEdit",
  "WebFetch",
] as const;
