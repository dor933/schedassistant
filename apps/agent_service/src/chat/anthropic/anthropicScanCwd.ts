/**
 * Read-only repo-scan invocation of the Claude Agent SDK.
 *
 * Sits between the tool-less `runAnthropicOneShot` (no tools, max 1 turn,
 * just text) and the full `runAnthropicAgentSdk` (LangChain MCP layer +
 * per-agent grants + sub-agent fan-out): this one runs the SDK in a
 * specific working directory with **only** the SDK's read-side built-ins
 * exposed (`Read`, `Glob`, `Grep`). No `Write`/`Edit`/`MultiEdit`/`Bash`,
 * no MCP servers, no LangChain tools, no per-agent grants — admin-callable
 * from contexts that don't have an agent row at all.
 *
 * Use case: generating the `repository.architecture_overview` text. The
 * model needs to walk the repo (`Glob` to enumerate folders, `Read` to
 * peek at package.json / README / key configs, `Grep` to confirm
 * patterns) but must NOT modify anything — this is a pure read.
 *
 * Replaces the legacy `runCliExecution`-based `runClaudeArchitecture`
 * spawn (slice 21). The SDK handles the subprocess lifecycle internally
 * via the same `spawnClaudeCodeProcess` hook the runner uses, so the
 * Claude Code binary still runs under `su-exec agent` with HOME pinned
 * to /home/agent — same security posture, less plumbing.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type {
  SpawnOptions,
  SpawnedProcess,
  query as queryFn,
} from "@anthropic-ai/claude-agent-sdk";

import { loadClaudeAgentSdk } from "./agentSdkLoader";
import { observeWithContext, recordSdkGeneration } from "../../langfuse";

const AGENT_USER = "agent";
const AGENT_HOME = "/home/agent";

/** Read-only scan tools. Deliberately excludes anything that mutates the
 *  repo (Write/Edit/MultiEdit), executes shell (Bash), or fetches over
 *  the network (WebFetch/WebSearch). */
const SCAN_ALLOWED_TOOLS = ["Read", "Glob", "Grep"] as const;

export interface AnthropicScanCwdOptions {
  /** Per-org Anthropic credential — `sk-ant-api…` key OR `sk-ant-oat…`
   *  OAuth token. `keyType` discriminates which env var receives it. */
  credential: string;
  keyType: "api_key" | "oauth_token" | null;
  /** Anthropic model slug (e.g. `claude-sonnet-4-6`). */
  model: string;
  /** Free-form system prompt — same shape as `runAnthropicOneShot.systemPrompt`. */
  systemPrompt: string;
  /** Free-form user prompt — typically the task ("scan this repo and
   *  produce…"). The model's `Read`/`Glob`/`Grep` calls land in `cwd`. */
  userPrompt: string;
  /** Absolute path the SDK should run in. Bare paths in the model's
   *  Read / Glob / Grep tool calls resolve relative to this — required
   *  for the scan to actually see the repo. */
  cwd: string;
  /**
   * Tool-loop budget. Each round = one model turn + any tool calls it
   * issues. Architecture-overview generation typically converges in
   * 10-20 rounds; we default to 35 to match the legacy CLI cap.
   */
  maxTurns?: number;
}

export interface AnthropicScanCwdResult {
  finalText: string;
  /** True when the SDK halted because we hit `maxTurns` — the result is
   *  the model's last in-flight reply, may be incomplete. Caller decides
   *  whether to retry with a higher budget. */
  hitMaxTurns: boolean;
}

function buildSdkEnv(
  credential: string,
  keyType: "api_key" | "oauth_token" | null,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const trimmed = credential.trim();
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
  env.HOME = AGENT_HOME;
  return env;
}

/**
 * Same shape as `runAnthropicAgentSdk.makeSpawnClaudeCodeAsAgent` but
 * forces `cwd` to the supplied scan target — that's what makes the
 * model's Glob calls enumerate this repo and not the parent process's
 * cwd. Wraps the spawn in `su-exec agent` so `bypassPermissions` is
 * accepted (the parent runs as root in production).
 */
function makeSpawnClaudeCodeAsAgent(cwd: string) {
  return (options: SpawnOptions): SpawnedProcess =>
    nodeSpawn("su-exec", [AGENT_USER, options.command, ...options.args], {
      cwd,
      env: {
        ...options.env,
        HOME: AGENT_HOME,
      },
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
    }) as unknown as SpawnedProcess;
}

/**
 * Drive the SDK to a final assistant text using only read-only built-ins.
 * Throws on SDK errors so callers' existing try/catch wrappers behave
 * identically to the legacy `runCliExecution` path.
 */
export async function runAnthropicScanCwd(
  opts: AnthropicScanCwdOptions,
): Promise<AnthropicScanCwdResult> {
  return observeWithContext(
    "anthropic_scan_cwd",
    async () => {
      const sdk = await loadClaudeAgentSdk();

      const stderrLines: string[] = [];
      const onStderr = (data: string) => {
        const trimmed = (data ?? "").toString();
        if (stderrLines.join("\n").length + trimmed.length < 8192) {
          stderrLines.push(trimmed);
        }
      };

      let finalText = "";
      let hitMaxTurns = false;
      let errorText: string | null = null;

      try {
        for await (const message of sdk.query({
          prompt: opts.userPrompt,
          options: {
            model: opts.model,
            systemPrompt: opts.systemPrompt,
            allowedTools: [...SCAN_ALLOWED_TOOLS],
            // No MCP servers — no LangChain layer, no per-agent grants.
            // This invocation is admin-callable; agent context isn't a
            // thing here.
            mcpServers: {},
            env: buildSdkEnv(opts.credential, opts.keyType),
            spawnClaudeCodeProcess: makeSpawnClaudeCodeAsAgent(opts.cwd),
            stderr: onStderr,
            maxTurns: opts.maxTurns ?? 35,
            // Headless server mode: no human at the keyboard to approve
            // each tool call. Tool surface is already constrained by
            // `allowedTools` above, so bypass is safe in this context.
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
          },
        } as Parameters<typeof queryFn>[0])) {
          const msg = message as unknown as Record<string, unknown>;
          const type = typeof msg.type === "string" ? msg.type : null;
          if (type === "result") {
            const subtype = typeof msg.subtype === "string" ? msg.subtype : null;
            if (subtype === "success") {
              if (typeof msg.result === "string") finalText = msg.result;
            } else if (subtype === "error_max_turns") {
              hitMaxTurns = true;
              if (typeof msg.result === "string") finalText = msg.result;
            } else {
              errorText =
                (typeof msg.result === "string" && msg.result) ||
                `Anthropic SDK returned non-success result: ${subtype ?? "unknown"}`;
            }
          }
        }
      } catch (err) {
        const baseMsg = err instanceof Error ? err.message : String(err);
        const stderrTail = stderrLines
          .join("")
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0)
          .slice(-20)
          .join("\n");
        errorText = stderrTail ? `${baseMsg}\n[stderr]\n${stderrTail}` : baseMsg;
      }

      if (errorText && !finalText) {
        throw new Error(errorText);
      }

      recordSdkGeneration({
        name: "anthropic_scan_cwd_generation",
        model: opts.model,
        input: {
          messages: [
            { role: "system", content: opts.systemPrompt },
            { role: "user", content: opts.userPrompt },
          ],
        },
        output: finalText,
        metadata: {
          vendor: "anthropic",
          cwd: opts.cwd,
          maxTurns: opts.maxTurns ?? 35,
          hitMaxTurns,
        },
      });

      return { finalText, hitMaxTurns };
    },
    { model: opts.model, cwd: opts.cwd },
  );
}
