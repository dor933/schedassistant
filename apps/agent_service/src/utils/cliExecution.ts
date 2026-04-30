import { spawn, spawnSync } from "child_process";
import { Op } from "sequelize";
import { CliExecution } from "@scheduling-agent/database";
import type {
  AgentId,
  AgentTaskId,
  CliExecutionId,
  CliInvokedVia,
  CliProvider,
  UserId,
} from "@scheduling-agent/types";
import { logger } from "../logger";
import { getCliAdapter, KNOWN_CLI_BINARIES } from "./cliProviders/registry";
import type { CliRunOptions } from "./cliProviders/types";

/**
 * The agent_service container runs as root, but every CLI subprocess must
 * run as the non-root `agent` user via `su-exec`. `su-exec` inherits env
 * unchanged, so HOME stays as /root unless we override it — which means
 * `claude` writes sessions to /root/.claude (read-only for `agent`) and
 * `codex` writes auth/cache to /root/.codex (same problem). Pinning HOME
 * to /home/agent puts every CLI's state on the persistent named volume
 * mounted there.
 *
 * Mirrors `agentSpawnEnv()` in epicTaskUtils.ts. Once that file is
 * refactored to use this engine, the duplicate disappears.
 */
const AGENT_HOME = "/home/agent";

function buildSpawnEnv(adapterEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: AGENT_HOME,
    ...adapterEnv,
  };
}

/**
 * Discriminator for the three flavors of busy-state we surface to callers.
 *
 * - `cross_agent`: another agent (or admin/system task) is running a CLI on
 *   this host. The calling agent must wait — it has no authority to kill
 *   work it doesn't own.
 *
 * - `own_agent`: the SAME agent already has a CLI in flight (typically
 *   because a worker died mid-run and its orphaned subprocess is still
 *   alive). The agent is told what's running, when it started, and the
 *   prompt snippet — and is instructed to ASK THE USER before killing it
 *   via `kill_cli_execution`. Only the user can decide "stuck vs. slow."
 *
 * - `untracked`: pgrep found a CLI process whose pid does not match any
 *   `cli_executions` row in `status='running'`. Most likely a CLI started
 *   manually (e.g. by an admin via shell). We refuse to spawn — the engine
 *   has no idea who owns it and can't make a safe decision.
 */
export type CliBusyKind = "cross_agent" | "own_agent" | "untracked";

/** Snapshot of the cli_executions row owning the busy pid, when known. */
export interface BusyExecutionInfo {
  id: CliExecutionId;
  agentId: AgentId | null;
  threadId: string | null;
  sessionId: string | null;
  /** Truncated to a few KB by the engine to keep the error payload cheap. */
  prompt: string;
  startedAt: Date;
  invokedVia: string;
  pid: number | null;
}

export class CliBusyError extends Error {
  readonly kind: CliBusyKind;
  readonly busyProvider: CliProvider;
  readonly busyPid: number;
  /** The cli_executions row that owns the busy pid. `null` for untracked. */
  readonly busyExecution: BusyExecutionInfo | null;

  constructor(args: {
    kind: CliBusyKind;
    busyProvider: CliProvider;
    busyPid: number;
    busyExecution: BusyExecutionInfo | null;
  }) {
    super(buildBusyMessage(args));
    this.name = "CliBusyError";
    this.kind = args.kind;
    this.busyProvider = args.busyProvider;
    this.busyPid = args.busyPid;
    this.busyExecution = args.busyExecution;
  }
}

function buildBusyMessage(args: {
  kind: CliBusyKind;
  busyProvider: CliProvider;
  busyPid: number;
  busyExecution: BusyExecutionInfo | null;
}): string {
  const exec = args.busyExecution;
  switch (args.kind) {
    case "untracked":
      return `Untracked ${args.busyProvider} CLI process running (pid ${args.busyPid}).`;
    case "cross_agent":
      return `Another agent's ${args.busyProvider} CLI is in flight (pid ${args.busyPid}, execution ${exec?.id ?? "?"}).`;
    case "own_agent":
      return `Your previous ${args.busyProvider} CLI is still running (pid ${args.busyPid}, execution ${exec?.id ?? "?"}).`;
  }
}

/**
 * Render a human / LLM-friendly multi-line BUSY message from a `CliBusyError`.
 * Used by `runCliTools.ts` to translate the structured error into the text
 * the LLM sees as the tool result. Lives here so both the run_*_cli tools
 * and the epic-flow `executeTask` produce identical phrasing if either ever
 * needs to surface it.
 */
export function formatBusyForTool(err: CliBusyError): string {
  const exec = err.busyExecution;
  const lines: string[] = [];

  if (err.kind === "untracked") {
    lines.push(
      `BUSY: An untracked ${err.busyProvider} CLI process is running on this host (pid ${err.busyPid}).`,
      `This usually means it was started outside this system. Refusing to spawn.`,
      `Surface to an admin if it persists.`,
    );
    return lines.join("\n");
  }

  if (!exec) {
    // Defensive — kind is cross_agent / own_agent but somehow we didn't
    // attach details. Fall back to the short message.
    return `BUSY: ${err.message}`;
  }

  const elapsed = formatElapsed(exec.startedAt);
  const promptSnippet = exec.prompt.length > 200
    ? exec.prompt.slice(0, 200) + "…"
    : exec.prompt;

  if (err.kind === "cross_agent") {
    const ownerLabel = exec.agentId
      ? `agent ${exec.agentId}`
      : `an admin/system process (no agent attribution)`;
    lines.push(
      `BUSY: ${ownerLabel} is currently running a ${err.busyProvider} CLI on this host:`,
      `  • execution: ${exec.id}`,
      `  • running for: ${elapsed} (started ${exec.startedAt.toISOString()})`,
      `  • invoked via: ${exec.invokedVia}`,
      ``,
      `Only one CLI can run per host at a time. Wait for it to finish — you cannot kill another agent's work.`,
      `Retry this tool in a few minutes.`,
    );
    return lines.join("\n");
  }

  // own_agent
  lines.push(
    `BUSY: You already have a ${err.busyProvider} CLI in flight from a prior turn:`,
    `  • execution: ${exec.id}`,
    `  • running for: ${elapsed} (started ${exec.startedAt.toISOString()})`,
    `  • thread: ${exec.threadId ?? "(none)"}`,
    `  • session_id: ${exec.sessionId ?? "(not yet captured)"}`,
    `  • prompt snippet: ${JSON.stringify(promptSnippet)}`,
    ``,
    `Decide based on elapsed time + prompt above whether it's stuck or just slow:`,
    `  • If it's likely still working → wait, do something else, retry this tool in a few minutes.`,
    `  • If it's likely stuck → ASK THE USER FIRST. Show them the elapsed time and prompt snippet,`,
    `    explain what was running, and let them decide. Only after they explicitly approve,`,
    `    call \`kill_cli_execution\` with the execution id above and the user's VERBATIM`,
    `    approval quote. Do not fabricate the quote — if they didn't approve, do not call it.`,
    `    (If \`kill_cli_execution\` is not available to you, surface to the user that you'd`,
    `    need an admin to grant it, then just wait.)`,
    ``,
    `If the previous run captured a session_id, the next run will \`--resume\` from there`,
    `and only bill for the additional turns — so killing isn't a full re-pay.`,
  );
  return lines.join("\n");
}

function formatElapsed(startedAt: Date): string {
  const ms = Date.now() - startedAt.getTime();
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

/** Truncate prompt persisted into the busy-error payload to avoid log spam. */
const BUSY_PROMPT_MAX_CHARS = 4_000;

/**
 * Cross-provider busy check. Refuses to spawn if any registered CLI binary
 * has a live process on the host.
 *
 * Source of truth is the OS, not the DB — a phantom `running` row left by a
 * crashed container shouldn't block new spawns, and a freshly-spawned CLI
 * not yet committed to the DB shouldn't be ignored.
 *
 * `pgrep -x <name>` matches the exact 15-char-truncated process name. Both
 * `claude` and `codex` fit comfortably under that limit.
 */
export function detectRunningCli(): {
  provider: CliProvider;
  pid: number;
} | null {
  for (const { provider, binary } of KNOWN_CLI_BINARIES) {
    const r = spawnSync("pgrep", ["-x", binary], { encoding: "utf-8" });
    if (r.status === 0 && r.stdout.trim()) {
      const firstPid = parseInt(r.stdout.trim().split(/\s+/)[0], 10);
      if (Number.isFinite(firstPid)) {
        return { provider, pid: firstPid };
      }
    }
  }
  return null;
}

export interface RunCliExecutionContext {
  provider: CliProvider;
  /**
   * Agent that triggered this run. `null` for admin-triggered runs (e.g.
   * "generate architecture overview" from the repo admin UI) — the lock
   * and accounting still apply, just without an agent attribution.
   */
  agentId: AgentId | null;
  invokedVia: CliInvokedVia;
  userId?: UserId | null;
  threadId?: string | null;
  agentTaskId?: AgentTaskId | null;
  /** Optional session id this run is resuming. Persisted as parent_session_id. */
  parentSessionId?: string | null;
  /** Pretty name for the CLI agent (claude `--agent-name`); persisted on the row. */
  cliAgentName?: string | null;
}

export interface RunCliExecutionResult {
  executionId: CliExecutionId;
  sessionId: string | null;
  resultText: string;
  exitCode: number | null;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  isError: boolean | null;
  status: "completed" | "failed" | "killed";
  /** stderr captured during the run; empty string when the process didn't write any. */
  stderr: string;
}

/**
 * Spawn a CLI subprocess via `su-exec agent <binary> <args>`, stream
 * stdout/stderr, persist the lifecycle to `cli_executions`, and return the
 * normalized result.
 *
 * Lifecycle:
 *   1. Pre-spawn: cross-provider pgrep busy check. Throws CliBusyError on hit.
 *   2. Insert `cli_executions` row with status='running' and the prompt/cwd.
 *   3. Spawn, capture stdout/stderr, await close (or kill on timeout).
 *   4. Parse stdout via the adapter; finalize the row with
 *      status/result/cost/session_id/exit_code/etc.
 *   5. Return a normalized result object — callers don't need to fetch the row.
 *
 * What this engine does NOT do (deliberately, so it stays callable from
 * non-epic agents):
 *   - git diff capture / pre-snapshot HEAD
 *   - safety-net `git add -A && git commit`
 *   - `agent_tasks` status updates
 *   - `task_executions` row creation
 *   - --resume retry-on-session-expired logic (the engine forwards
 *     resumeSessionId once; epic-flow callers handle the retry by
 *     calling the engine again with resumeSessionId=null)
 */
export async function runCliExecution(
  opts: CliRunOptions,
  ctx: RunCliExecutionContext,
): Promise<RunCliExecutionResult> {
  const adapter = getCliAdapter(ctx.provider);

  const busy = detectRunningCli();
  if (busy) {
    // Look up the cli_executions row that owns this pid (if any). Three
    // outcomes drive the BUSY classification:
    //   - row exists, agent_id matches caller     → own_agent (orphan from a
    //     crashed worker — the calling agent has the authority to ask the
    //     user about killing it via `kill_cli_execution`)
    //   - row exists, agent_id differs / null     → cross_agent (someone else's
    //     run; calling agent cannot kill it, must wait)
    //   - no row matches the pid                  → untracked (CLI started
    //     outside the system, e.g. by an admin via shell)
    //
    // We restrict to status='running' so a finished row reusing the pid
    // (highly unlikely but possible after pid recycling) doesn't masquerade
    // as the busy owner.
    const row = await CliExecution.findOne({
      where: { pid: busy.pid, status: "running" },
      order: [["started_at", "DESC"]],
      attributes: [
        "id",
        "agentId",
        "threadId",
        "sessionId",
        "prompt",
        "startedAt",
        "invokedVia",
        "pid",
      ],
    });

    if (!row) {
      throw new CliBusyError({
        kind: "untracked",
        busyProvider: busy.provider,
        busyPid: busy.pid,
        busyExecution: null,
      });
    }

    const sameAgent =
      ctx.agentId !== null &&
      row.agentId !== null &&
      row.agentId === ctx.agentId;

    const exec: BusyExecutionInfo = {
      id: row.id,
      agentId: row.agentId,
      threadId: row.threadId,
      sessionId: row.sessionId,
      prompt:
        (row.prompt ?? "").length > BUSY_PROMPT_MAX_CHARS
          ? (row.prompt ?? "").slice(0, BUSY_PROMPT_MAX_CHARS)
          : row.prompt ?? "",
      startedAt: row.startedAt,
      invokedVia: row.invokedVia,
      pid: row.pid,
    };

    throw new CliBusyError({
      kind: sameAgent ? "own_agent" : "cross_agent",
      busyProvider: busy.provider,
      busyPid: busy.pid,
      busyExecution: exec,
    });
  }

  const args = adapter.buildArgs(opts);

  const row = await CliExecution.create({
    provider: ctx.provider,
    agentId: ctx.agentId,
    userId: ctx.userId ?? null,
    threadId: ctx.threadId ?? null,
    agentTaskId: ctx.agentTaskId ?? null,
    cwd: opts.cwd,
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt ?? null,
    cliAgentName: ctx.cliAgentName ?? null,
    model: opts.model ?? null,
    parentSessionId: ctx.parentSessionId ?? opts.resumeSessionId ?? null,
    invokedVia: ctx.invokedVia,
    providerMetadata: (opts.providerOpts as Record<string, unknown>) ?? {},
  });

  logger.info("runCliExecution: spawning", {
    executionId: row.id,
    provider: ctx.provider,
    binary: adapter.binary,
    cwd: opts.cwd,
    agentId: ctx.agentId,
    threadId: ctx.threadId ?? null,
    invokedVia: ctx.invokedVia,
    resumeSessionId: opts.resumeSessionId ?? null,
  });

  const startedMs = Date.now();
  return new Promise<RunCliExecutionResult>((resolve, reject) => {
    const child = spawn("su-exec", ["agent", adapter.binary, ...args], {
      cwd: opts.cwd,
      env: buildSpawnEnv(adapter.envVars()),
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Persist the OS pid as soon as we have it — gives the busy check and
    // an admin "kill stuck CLI" tool something to act on without waiting
    // for the row to be finalized on close.
    if (typeof child.pid === "number") {
      void row
        .update({ pid: child.pid })
        .catch((err) =>
          logger.warn("runCliExecution: pid persist failed (non-fatal)", {
            executionId: row.id,
            error: err?.message,
          }),
        );
    }

    let stdout = "";
    let stderr = "";

    // Streaming aggregation. Every newline-delimited stdout event is fed to
    // `adapter.parseStreamLine` and merged into `captured`. The first time
    // we see a `session_id`, we fire a non-blocking row.update so a worker
    // crash later in the run still leaves enough on disk for the next
    // attempt to `--resume`. All other fields land here as they're
    // observed and are merged with the final parseOutput pass at close
    // time (captured wins because it parsed events as they happened).
    let lineBuf = "";
    let sessionPersisted = false;
    const captured: Partial<ReturnType<typeof adapter.parseStreamLine>> = {};

    child.stdout.on("data", (d: Buffer) => {
      const text = d.toString();
      stdout += text;
      lineBuf += text;

      let nl: number;
      while ((nl = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line) continue;

        const partial = adapter.parseStreamLine(line);
        if (Object.keys(partial).length === 0) continue;

        Object.assign(captured, partial);

        if (partial.sessionId && !sessionPersisted) {
          sessionPersisted = true;
          // Fire-and-forget — one DB write per run. If it fails we let the
          // close handler's full update overwrite later. Don't await: this
          // runs inside the stdout event loop and a slow DB shouldn't
          // backpressure the CLI subprocess.
          row
            .update({ sessionId: partial.sessionId })
            .catch((err) => {
              sessionPersisted = false; // allow another attempt on a later event
              logger.warn(
                "runCliExecution: mid-run session_id persist failed (will retry on close)",
                { executionId: row.id, error: err?.message },
              );
            });
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const timeoutMs = opts.timeoutMs;
    if (timeoutMs && timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        logger.warn("runCliExecution: timeout — sending SIGTERM", {
          executionId: row.id,
          timeoutMs,
        });
        child.kill("SIGTERM");
        // Hard backstop in case SIGTERM is ignored.
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 10_000).unref();
      }, timeoutMs);
    }

    child.on("error", async (err) => {
      if (killTimer) clearTimeout(killTimer);
      logger.error("runCliExecution: spawn error", {
        executionId: row.id,
        provider: ctx.provider,
        error: err.message,
      });
      const durationMs = Date.now() - startedMs;
      try {
        await row.update({
          status: "failed",
          stderr: err.message,
          exitCode: null,
          durationMs,
          completedAt: new Date(),
        });
      } catch (persistErr: any) {
        logger.warn("runCliExecution: failed-row update failed", {
          executionId: row.id,
          error: persistErr?.message,
        });
      }
      reject(err);
    });

    child.on("close", async (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      const wallDurationMs = Date.now() - startedMs;

      // Drain any final unterminated line that was sitting in lineBuf
      // (CLI process may close stdout without a trailing newline).
      const remainder = lineBuf.trim();
      if (remainder) {
        const partial = adapter.parseStreamLine(remainder);
        if (Object.keys(partial).length > 0) Object.assign(captured, partial);
      }

      // Final-pass parse over the full stdout as a fallback. `captured` (built
      // incrementally from streaming) wins on every field — it saw events as
      // they happened. parseOutput just fills in anything streaming missed,
      // and gracefully handles legacy single-JSON output from older builds.
      const fromFinal = adapter.parseOutput(stdout);
      const merged = {
        resultText: captured.resultText ?? fromFinal.resultText,
        sessionId: captured.sessionId ?? fromFinal.sessionId ?? null,
        model: captured.model ?? fromFinal.model ?? null,
        costUsd: captured.costUsd ?? fromFinal.costUsd ?? null,
        durationMs:
          typeof captured.durationMs === "number"
            ? captured.durationMs
            : typeof fromFinal.durationMs === "number"
            ? fromFinal.durationMs
            : null,
        numTurns: captured.numTurns ?? fromFinal.numTurns ?? null,
        isError: captured.isError ?? fromFinal.isError ?? null,
      };

      const resultText =
        typeof merged.resultText === "string" && merged.resultText.length > 0
          ? merged.resultText
          : stdout;

      // Status precedence: timeout/signal beats exit code, since a process
      // killed by SIGTERM may still exit with 0 from its trap handler.
      const status: "completed" | "failed" | "killed" = timedOut
        ? "killed"
        : signal
        ? "killed"
        : code === 0
        ? "completed"
        : "failed";

      try {
        await row.update({
          status,
          result: resultText,
          stderr: stderr || null,
          exitCode: code,
          sessionId: merged.sessionId,
          model: merged.model ?? row.model,
          costUsd: merged.costUsd,
          // Adapter-reported duration_ms takes priority when present
          // (closer to the model-perceived value); else our wall-clock.
          durationMs:
            typeof merged.durationMs === "number"
              ? merged.durationMs
              : wallDurationMs,
          numTurns: merged.numTurns,
          isError: merged.isError,
          completedAt: new Date(),
        });
      } catch (persistErr: any) {
        logger.error("runCliExecution: row finalize failed", {
          executionId: row.id,
          error: persistErr?.message,
        });
      }

      logger.info("runCliExecution: finished", {
        executionId: row.id,
        provider: ctx.provider,
        status,
        exitCode: code,
        signal,
        wallDurationMs,
        sessionId: merged.sessionId,
        sessionMidRunPersisted: sessionPersisted,
        costUsd: merged.costUsd,
      });

      resolve({
        executionId: row.id,
        sessionId: merged.sessionId,
        resultText,
        exitCode: code,
        costUsd: merged.costUsd,
        durationMs:
          typeof merged.durationMs === "number"
            ? merged.durationMs
            : wallDurationMs,
        numTurns: merged.numTurns,
        isError: merged.isError,
        status,
        stderr,
      });
    });
  });
}

/**
 * Look up the most recent resumable session id for (provider, agent, thread)
 * so a follow-up CLI run can pass `--resume`. Returns null when there's no
 * usable prior session.
 *
 * Eligible source rows:
 *   - `status='completed'` with a captured `session_id` — the natural happy
 *     path (the previous turn finished cleanly).
 *   - `status='killed'` AND `provider_metadata.killApprovalQuote IS NOT NULL`
 *     — the row was killed via the `kill_cli_execution` tool with explicit
 *     user approval (e.g. an orphan from a crashed worker that the user
 *     decided to abort). The session is still on disk in `~/.claude` /
 *     `~/.codex`, so claude/codex can `--resume` from where it left off
 *     and only bill the additional turns. This is what makes the
 *     orphan-detect → kill → restart loop cost-efficient instead of a
 *     full re-pay.
 *
 * Excluded:
 *   - `status='failed'` — the CLI may have crashed before checkpointing;
 *     resume could land in an undefined state.
 *   - `status='killed'` without `killApprovalQuote` — those were killed by
 *     the startup sweep (orphan from container crash, where the OS process
 *     is gone) or by a wall-clock timeout. Their session state is unsafe
 *     to assume intact.
 *   - `status='running'` — the previous run is still in flight; the engine
 *     would surface that as own-agent BUSY, not silently resume.
 *
 * Implementation: candidate rows are fetched ordered by `completed_at DESC`;
 * we walk them and return the first that passes the `status === 'killed'`
 * approval check (the JSONB filter is done in JS rather than SQL — both are
 * fine, the JS path keeps the query portable and the candidate set is tiny
 * for any single thread).
 */
export async function findResumableSession(args: {
  provider: CliProvider;
  agentId: AgentId;
  threadId: string | null | undefined;
}): Promise<string | null> {
  if (!args.threadId) return null;
  const candidates = await CliExecution.findAll({
    where: {
      provider: args.provider,
      agentId: args.agentId,
      threadId: args.threadId,
      status: { [Op.in]: ["completed", "killed"] },
      sessionId: { [Op.ne]: null },
    },
    order: [["completed_at", "DESC"]],
    attributes: ["id", "sessionId", "status", "providerMetadata"],
    limit: 5,
  });

  for (const row of candidates) {
    if (row.status === "completed") {
      return row.sessionId;
    }
    // status === 'killed' — only resumable when killed via the user-approval
    // path (kill_cli_execution wrote killApprovalQuote into providerMetadata).
    const meta = (row.providerMetadata ?? {}) as Record<string, unknown>;
    if (typeof meta.killApprovalQuote === "string" && meta.killApprovalQuote.length > 0) {
      return row.sessionId;
    }
  }
  return null;
}

/**
 * Startup sweep. Any `cli_executions` row left in `status='running'` was
 * orphaned by a previous container life — the OS process is gone, but the
 * row still says running. Mark them as `killed` so the partial running-index
 * stays accurate and admin dashboards don't show phantom in-flight work.
 *
 * Idempotent — safe to run on every boot.
 */
export async function markStaleRunningExecutions(): Promise<number> {
  const [count] = await CliExecution.update(
    {
      status: "killed",
      stderr: "process killed before completion (sweep on startup)",
      exitCode: -1,
      completedAt: new Date(),
    },
    { where: { status: "running" } },
  );
  if (count > 0) {
    logger.warn("markStaleRunningExecutions: swept stale running rows", {
      count,
    });
  }
  return count;
}
