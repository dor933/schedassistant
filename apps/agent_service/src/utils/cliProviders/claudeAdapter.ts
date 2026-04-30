import type { CliProviderAdapter, CliRunOptions, CliRunResult } from "./types";
import { getClaudeMcpConfigPath } from "../../services/claudeMcpConfig.service";

/**
 * Claude Code CLI adapter (`claude`).
 *
 * Mirrors the flags the existing `executeTask` builds in epicTaskUtils.ts:
 *   - `-p <prompt>`                — non-interactive single-shot
 *   - `--dangerously-skip-permissions` — required because the CLI runs
 *     under `su-exec agent` with no interactive TTY for approvals
 *   - `--output-format stream-json` + `--verbose` — newline-delimited event
 *     stream. The first event is `{type:"system",subtype:"init",session_id}`,
 *     emitted within the first second of the run. The engine persists that
 *     `session_id` to `cli_executions` immediately so a worker crash mid-run
 *     leaves enough state for the next attempt to `--resume`. The final
 *     event is `{type:"result",cost_usd,duration_ms,num_turns,result,...}`
 *     and gives us the rest of the common-shape fields.
 *     `--verbose` is REQUIRED with `stream-json` — without it claude only
 *     emits the final result event, defeating the whole point.
 *   - `--max-turns <n>`            — default 200 (CLI default ~21 is too low)
 *   - `--append-system-prompt`     — system_prompt extension
 *   - `--name`                     — labels the run in `~/.claude/sessions`
 *   - `--allowed-tools`            — provider-specific allowlist
 *   - `--mcp-config`               — generated MCP config from the DB registry
 *   - `--resume <sessionId>`       — continue a prior session
 *
 * Auth: `CLAUDE_CODE_OAUTH_TOKEN` is loaded into `process.env` at startup
 * by `claudeOauthToken.service.loadIntoEnv()`. We don't re-read it here —
 * the engine spreads `process.env` first, then merges this adapter's env on
 * top, which is empty for claude (auth already in env).
 */
export const claudeAdapter: CliProviderAdapter = {
  name: "claude",
  binary: "claude",

  buildArgs(opts: CliRunOptions): string[] {
    const provider = opts.providerOpts ?? {};
    const args: string[] = ["-p", opts.prompt];

    const bypassPermissions = provider.bypassPermissions !== false;
    if (bypassPermissions) {
      args.push("--dangerously-skip-permissions");
    }

    const permissionMode =
      typeof provider.permissionMode === "string"
        ? provider.permissionMode
        : undefined;
    if (!bypassPermissions && permissionMode) {
      args.push("--permission-mode", permissionMode);
    }

    args.push(
      "--output-format",
      "stream-json",
      // --verbose is REQUIRED with stream-json — without it claude collapses
      // back to emitting only the final event, which defeats mid-run
      // session_id capture for crash recovery.
      "--verbose",
    );

    if (opts.resumeSessionId) {
      args.push("--resume", opts.resumeSessionId);
    }

    const maxTurns =
      typeof provider.maxTurns === "number" ? provider.maxTurns : 200;
    args.push("--max-turns", String(maxTurns));

    const effort = typeof provider.effort === "string" ? provider.effort : undefined;
    if (effort) {
      args.push("--effort", effort);
    }

    const fallbackModel =
      typeof provider.fallbackModel === "string" ? provider.fallbackModel : undefined;
    if (fallbackModel) {
      args.push("--fallback-model", fallbackModel);
    }

    const maxBudgetUsd =
      typeof provider.maxBudgetUsd === "number" ? provider.maxBudgetUsd : undefined;
    if (maxBudgetUsd !== undefined) {
      args.push("--max-budget-usd", String(maxBudgetUsd));
    }

    if (opts.systemPrompt) {
      args.push("--append-system-prompt", opts.systemPrompt);
    }

    const sessionName =
      typeof provider.sessionName === "string"
        ? provider.sessionName
        : typeof provider.agentName === "string"
        ? provider.agentName
        : undefined;
    if (sessionName) {
      args.push("--name", sessionName);
    }

    const claudeAgent =
      typeof provider.claudeAgent === "string" ? provider.claudeAgent : undefined;
    if (claudeAgent) {
      args.push("--agent", claudeAgent);
    }

    pushStringListFlag(args, "--allowedTools", provider.allowedTools);
    pushStringListFlag(args, "--disallowedTools", provider.disallowedTools);

    const tools = normalizeStringList(provider.tools);
    if (tools.length > 0) {
      args.push("--tools", tools.join(","));
    }

    for (const dir of normalizeStringList(provider.addDirs)) {
      args.push("--add-dir", dir);
    }

    const useDbMcpConfig = provider.useDbMcpConfig !== false;
    if (useDbMcpConfig && provider.bare !== true) {
      args.push("--mcp-config", getClaudeMcpConfigPath());
    }
    for (const mcpConfigPath of normalizeStringList(provider.mcpConfigPaths)) {
      args.push("--mcp-config", mcpConfigPath);
    }
    if (provider.strictMcpConfig === true) {
      args.push("--strict-mcp-config");
    }

    const agentsJson =
      typeof provider.agentsJson === "string" ? provider.agentsJson : undefined;
    if (agentsJson) {
      args.push("--agents", agentsJson);
    }

    if (provider.bare === true) {
      args.push("--bare");
    }

    if (provider.chrome === true) {
      args.push("--chrome");
    } else if (provider.chrome === false) {
      args.push("--no-chrome");
    }

    if (opts.resumeSessionId && provider.forkSession === true) {
      args.push("--fork-session");
    }

    const settingSources = normalizeStringList(provider.settingSources);
    if (settingSources.length > 0) {
      args.push("--setting-sources", settingSources.join(","));
    }

    if (opts.model) {
      args.push("--model", opts.model);
    }

    return args;
  },

  parseStreamLine(line: string): Partial<CliRunResult> {
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") return {};
      event = parsed as Record<string, unknown>;
    } catch {
      return {};
    }

    const type = typeof event.type === "string" ? event.type : "";
    const sessionId =
      typeof event.session_id === "string" ? event.session_id : null;

    switch (type) {
      case "system": {
        // First event of every run — the only place session_id is guaranteed
        // to land before the model has done any real work. Persisting this
        // mid-run is the foundation for crash recovery + --resume.
        const out: Partial<CliRunResult> = {};
        if (sessionId) out.sessionId = sessionId;
        if (typeof event.model === "string") out.model = event.model;
        return out;
      }

      case "result": {
        // Final event — carries everything we want for the close-handler row
        // finalize. session_id is repeated here, harmless to overwrite.
        const out: Partial<CliRunResult> = {};
        if (typeof event.result === "string") out.resultText = event.result;
        if (sessionId) out.sessionId = sessionId;
        if (typeof event.model === "string") out.model = event.model;
        if (typeof event.cost_usd === "number") out.costUsd = event.cost_usd;
        if (typeof event.duration_ms === "number")
          out.durationMs = event.duration_ms;
        if (typeof event.num_turns === "number") out.numTurns = event.num_turns;
        if (typeof event.is_error === "boolean") out.isError = event.is_error;
        return out;
      }

      // assistant / user / tool_use / tool_result events: the engine doesn't
      // need them for the cli_executions row. They're still in the captured
      // stdout if anyone wants to mine them later.
      default:
        return {};
    }
  },

  parseOutput(stdout: string): Partial<CliRunResult> {
    // Walk newline-delimited events and merge. Fallback path #1: stream-json
    // (the new default) — every line is an event. Fallback path #2: legacy
    // single-JSON output (older claude builds, or future format changes) —
    // JSON.parse the whole blob.
    const merged: Partial<CliRunResult> = {};
    let sawEvent = false;

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const partial = this.parseStreamLine(trimmed);
      if (Object.keys(partial).length > 0) {
        sawEvent = true;
        Object.assign(merged, partial);
      }
    }

    if (sawEvent) return merged;

    // Legacy single-JSON fallback (pre-stream-json builds).
    try {
      const parsed = JSON.parse(stdout);
      return {
        resultText: typeof parsed.result === "string" ? parsed.result : stdout,
        sessionId:
          typeof parsed.session_id === "string" ? parsed.session_id : null,
        model: typeof parsed.model === "string" ? parsed.model : null,
        costUsd:
          typeof parsed.cost_usd === "number" ? parsed.cost_usd : null,
        durationMs:
          typeof parsed.duration_ms === "number" ? parsed.duration_ms : null,
        numTurns:
          typeof parsed.num_turns === "number" ? parsed.num_turns : null,
        isError:
          typeof parsed.is_error === "boolean" ? parsed.is_error : null,
      };
    } catch {
      return { resultText: stdout };
    }
  },

  envVars(): NodeJS.ProcessEnv {
    // `CLAUDE_CODE_OAUTH_TOKEN` is already in process.env via
    // `loadClaudeOauthTokenIntoEnv()` at startup; the engine spreads
    // process.env first, so nothing extra to merge here.
    return {};
  },
};

function normalizeStringList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function pushStringListFlag(args: string[], flag: string, value: unknown): void {
  const values = normalizeStringList(value);
  if (values.length > 0) args.push(flag, values.join(","));
}
