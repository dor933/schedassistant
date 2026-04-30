import type { CliProvider } from "@scheduling-agent/types";

/**
 * Provider-agnostic spawn input. Each adapter is responsible for translating
 * these into provider-specific CLI flags via `buildArgs`.
 *
 * Anything outside this shape that a single provider exposes (e.g. claude's
 * `--allowed-tools`, codex's `--profile` / `--reasoning-effort`) goes in
 * `providerOpts` and is mirrored into `cli_executions.provider_metadata`
 * for audit. Keeping the common shape small means the engine never has to
 * branch on `provider` outside `buildArgs` / `parseOutput`.
 */
export interface CliRunOptions {
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  /** Concrete model id (e.g. "sonnet", "opus", "gpt-5-codex"). Provider-resolved if omitted. */
  model?: string;
  /** Resume a prior session. Format is provider-opaque; we pass it through. */
  resumeSessionId?: string;
  /** Hard timeout for the whole subprocess. Adapter default if omitted. */
  timeoutMs?: number;
  /** Any flags / extras the common shape doesn't cover. Forwarded to `buildArgs`. */
  providerOpts?: Record<string, unknown>;
}

/**
 * Common shape extracted from every provider's structured output. Anything
 * a particular provider doesn't report stays `null`.
 */
export interface CliRunResult {
  resultText: string;
  sessionId: string | null;
  model: string | null;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  isError: boolean | null;
}

/**
 * One adapter per CLI binary. The engine calls `buildArgs` to produce the
 * argv tail (everything after `claude`/`codex`), spawns the process, and
 * hands the captured stdout to `parseOutput`.
 *
 * Adapters do NOT know about the database, the busy lock, or
 * `agent_tasks` — they're pure CLI translators. That separation is what
 * lets `runCliExecution()` host a single spawn loop usable by both
 * providers and any future ones.
 */
export interface CliProviderAdapter {
  name: CliProvider;
  /** OS process name as `pgrep -x` sees it. Used by the busy check. */
  binary: string;
  /** Argv tail after the binary name. */
  buildArgs(opts: CliRunOptions): string[];
  /**
   * Incremental parser for one newline-delimited event from the CLI's
   * streaming output. Engine calls this per line as bytes arrive, so
   * fields like `session_id` (emitted within the first second of a run)
   * can be persisted to `cli_executions` long before the run finishes.
   * That is what makes crash recovery cheap: a worker that dies mid-run
   * still leaves `session_id` on disk, and the next attempt can `--resume`.
   *
   * Most lines yield `{}`. The init/system event yields `{sessionId,model?}`.
   * The final result event yields the full common-shape (resultText, cost,
   * duration, turns, is_error, sessionId).
   */
  parseStreamLine(line: string): Partial<CliRunResult>;
  /**
   * Final-pass parser over the full captured stdout. Used by the engine's
   * close handler as a fallback / sanity-check after the streaming pass.
   * Implementations should walk newline-delimited events and merge them
   * via `parseStreamLine` so behavior stays consistent.
   */
  parseOutput(stdout: string): Partial<CliRunResult>;
  /** Auth env to merge on top of the agent process env at spawn time. */
  envVars(): NodeJS.ProcessEnv;
}
