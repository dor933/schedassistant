import type { CliProviderAdapter, CliRunOptions, CliRunResult } from "./types";

/**
 * OpenAI Codex CLI adapter (`codex`).
 *
 * ⚠ Flag set is moving — verify against `codex --help` before first use.
 * Below reflects codex 0.x as of late 2025:
 *   - `exec <prompt>`              — non-interactive single-shot
 *   - `--cd <dir>`                 — set working directory (we still set
 *     `cwd` on spawn; `--cd` is belt-and-suspenders for codex's model
 *     when it tries to resolve relative paths)
 *   - `--model <id>`               — gpt-5-codex, etc.
 *   - `--dangerously-bypass-approvals-and-sandbox` — full equivalent of
 *     claude's `--dangerously-skip-permissions`. `--full-auto` is NOT
 *     enough: modern codex `--full-auto` only auto-approves prompts but
 *     leaves the network/filesystem sandbox in place, which would block
 *     the CLI from making model calls or running git operations. We need
 *     full bypass because the CLI runs under `su-exec agent` with no TTY
 *     and no chance to grant individual permissions.
 *   - `--json`                     — structured output (newer codex);
 *     we parse defensively in case the build is older and emits text
 *   - `--profile <name>`           — pull settings from
 *     ~/.codex/config.toml profile
 *   - `--search`, `--image`, and `-c` config overrides are surfaced through
 *     `run_codex_cli` providerOpts. We intentionally do not pass sandbox or
 *     approval-policy flags here: this service runs Codex non-interactively
 *     with the full permissions bypass every time.
 *   - Resume: documented as `codex exec resume [SESSION_ID]`. We insert
 *     that subcommand when `resumeSessionId` is present.
 *
 * Auth: codex prefers `OPENAI_API_KEY`, but also reads
 * `~/.codex/auth.json` written by `codex login`. The engine spreads
 * `process.env` (which our codex token service populates with
 * OPENAI_API_KEY at startup), then merges `envVars()` — empty here for
 * the same reason as claude.
 */
export const codexAdapter: CliProviderAdapter = {
  name: "codex",
  binary: "codex",

  buildArgs(opts: CliRunOptions): string[] {
    const provider = opts.providerOpts ?? {};
    const args: string[] = ["exec"];
    if (opts.resumeSessionId) {
      args.push("resume", opts.resumeSessionId);
    }

    // Always run with full permissions. The CLI is non-interactive under
    // `su-exec agent`, so approval prompts cannot be serviced, and the
    // product requirement is that Codex has all needed permissions.
    args.push("--dangerously-bypass-approvals-and-sandbox");

    // Always emit structured output when supported. Older codex builds
    // ignore unknown flags; newer ones honor it. parseOutput handles both.
    args.push("--json");

    args.push("--cd", opts.cwd);

    if (opts.model) {
      args.push("--model", opts.model);
    }

    const profile =
      typeof provider.profile === "string" ? provider.profile : undefined;
    if (profile) {
      args.push("--profile", profile);
    }

    if (provider.webSearch === "live") {
      args.push("--search");
    }

    if (Array.isArray(provider.imagePaths)) {
      const imagePaths = provider.imagePaths.filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      );
      if (imagePaths.length > 0) {
        args.push("--image", imagePaths.join(","));
      }
    }

    const configOverrides =
      provider.configOverrides &&
      typeof provider.configOverrides === "object" &&
      !Array.isArray(provider.configOverrides)
        ? (provider.configOverrides as Record<string, unknown>)
        : {};
    for (const [key, value] of Object.entries(configOverrides)) {
      if (!isSafeConfigKey(key) || value === undefined) continue;
      args.push("-c", `${key}=${formatConfigValue(value)}`);
    }

    if (opts.systemPrompt) {
      // codex doesn't have a direct equivalent of claude's
      // `--append-system-prompt`; the convention is to prepend it to the
      // prompt itself, separated by a markdown header.
      args.push(
        `# System\n${opts.systemPrompt}\n\n# Task\n${opts.prompt}`,
      );
    } else {
      args.push(opts.prompt);
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

    // Codex's event taxonomy isn't standardized across releases — different
    // builds use `type`, `event`, `kind`, or omit the discriminator entirely
    // and rely on field presence. Strategy: extract whatever common-shape
    // fields are present on this line, regardless of the wrapping.
    const type =
      pickString(event, ["type", "event", "kind"])?.toLowerCase() ?? "";

    const sessionId = pickString(event, ["session_id", "sessionId", "id"]);
    const model = pickString(event, ["model", "model_id"]);
    const resultText = pickString(event, ["result", "output", "message", "text"]);
    const costUsd = pickNumber(event, ["cost_usd", "costUsd", "usage_cost"]);
    const durationMs = pickNumber(event, [
      "duration_ms",
      "durationMs",
      "elapsed_ms",
    ]);
    const numTurns = pickNumber(event, ["num_turns", "turns"]);
    const isError = pickBool(event, ["is_error", "isError", "error"]);

    // Decide what to surface based on the discriminator (when present) +
    // field presence:
    //   - "session.created" / "session" / "init" / "system" → session id
    //     + model (the early-stream event we want to capture mid-run)
    //   - "result" / "completed" / "summary" / "done" → full final shape
    //   - anything else → only return non-null fields it happens to carry
    //
    // We keep this loose because codex evolves; a build that adds a new
    // event type without a discriminator still gets fields populated as
    // long as the field names match one of our pickX() candidate lists.
    const isInitLike = /^(session\.created|session|init|system)/.test(type);
    const isResultLike = /^(result|completed|summary|done|exit)/.test(type);

    if (isInitLike) {
      const out: Partial<CliRunResult> = {};
      if (sessionId) out.sessionId = sessionId;
      if (model) out.model = model;
      return out;
    }

    if (isResultLike) {
      const out: Partial<CliRunResult> = {};
      if (resultText !== null) out.resultText = resultText;
      if (sessionId) out.sessionId = sessionId;
      if (model) out.model = model;
      if (costUsd !== null) out.costUsd = costUsd;
      if (durationMs !== null) out.durationMs = durationMs;
      if (numTurns !== null) out.numTurns = numTurns;
      if (isError !== null) out.isError = isError;
      return out;
    }

    // Untyped / unknown event — surface fields opportunistically. Most
    // assistant/user message events don't carry any of these and return {}.
    const out: Partial<CliRunResult> = {};
    if (sessionId) out.sessionId = sessionId;
    if (model) out.model = model;
    return out;
  },

  parseOutput(stdout: string): Partial<CliRunResult> {
    // Walk newline-delimited events and merge. Codex's batch mode (one JSON
    // object) is rare in stream-mode runs, so we try ndjson first and only
    // fall back to single-JSON if no event yielded anything useful.
    const merged: Partial<CliRunResult> = {};
    let sawUseful = false;

    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const partial = this.parseStreamLine(trimmed);
      if (Object.keys(partial).length > 0) {
        sawUseful = true;
        Object.assign(merged, partial);
      }
    }

    if (sawUseful) {
      // Backfill resultText from raw stdout if no result event named one.
      if (!merged.resultText) merged.resultText = stdout;
      return merged;
    }

    // Pre-streaming or non-JSON output — return stdout as the resultText
    // so the caller still gets something.
    return { resultText: stdout };
  },

  envVars(): NodeJS.ProcessEnv {
    return {};
  },
};

function isSafeConfigKey(key: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(key);
}

function formatConfigValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") return v;
  }
  return null;
}

function pickNumber(
  obj: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function pickBool(
  obj: Record<string, unknown>,
  keys: string[],
): boolean | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "boolean") return v;
  }
  return null;
}
