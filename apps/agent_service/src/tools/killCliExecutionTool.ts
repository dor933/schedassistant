import { tool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "node:fs/promises";
import { CliExecution } from "@scheduling-agent/database";
import type { AgentId, UserId } from "@scheduling-agent/types";
import { logger } from "../logger";
import { getCliAdapter } from "../utils/cliProviders/registry";

/**
 * `kill_cli_execution` — abort an own-agent CLI subprocess that's still in
 * flight (typically an orphan from a worker that died mid-run). Auto-bound
 * to any agent that has `run_claude_cli` or `run_codex_cli` granted: if you
 * can spawn a CLI you should be able to abort yours.
 *
 * Authorization:
 *   - The calling agent can only kill executions where `agent_id` matches
 *     itself. Cross-agent kills are refused — admin overrides would be a
 *     separate tool.
 *   - The user-approval quote is required by schema. We log it for audit
 *     but cannot semantically verify it. The system prompt / tool
 *     description must discourage fabrication; same trust model as
 *     `approve_stage` in the epic flow.
 *
 * Safety:
 *   - PID-recycle guard: before sending SIGTERM, read `/proc/<pid>/comm`
 *     and verify the live process name matches the row's provider binary.
 *     If the pid was recycled to a different process, refuse the signal
 *     and just reconcile the row to `killed`.
 *   - SIGKILL backstop fires 10s after SIGTERM if the process is still
 *     present. Backstop is fire-and-forget — we don't await it before
 *     returning to the LLM.
 *
 * Cost-amortization handshake:
 *   - The row's `session_id` (captured mid-run by the streaming parser) is
 *     preserved on the killed row. Once `findResumableSession` is extended
 *     to accept `status='killed'` (the next change), the next
 *     `run_<provider>_cli` call from this agent on this thread will
 *     `--resume` from there and only bill the additional turns.
 */

const SCHEMA = z.object({
  executionId: z
    .string()
    .uuid()
    .describe(
      "ID of the cli_executions row to kill. Read it from the BUSY message " +
        "you got back from `run_claude_cli` / `run_codex_cli`.",
    ),
  userApprovalQuote: z
    .string()
    .min(3)
    .describe(
      "The user's VERBATIM words approving this kill. Required — do NOT " +
        "fabricate. If the user said 'kill it' just write 'kill it'. If " +
        "they did not approve, do not call this tool. The quote is logged " +
        "verbatim into provider_metadata for audit.",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "One sentence on why the user wanted it killed (stuck, no longer " +
        "needed, wrong prompt, etc.) — recorded for audit. Optional.",
    ),
});

async function readProcessName(pid: number): Promise<string | null> {
  try {
    const raw = await fs.readFile(`/proc/${pid}/comm`, "utf-8");
    return raw.trim();
  } catch (err: any) {
    // ENOENT = the process is gone; anything else (EACCES, etc.) we treat
    // as "can't tell" and surface so the caller decides not to kill.
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export function KillCliExecutionTool(
  callerAgentId: AgentId,
  _userId: UserId | null,
) {
  return tool(
    async (rawInput): Promise<string> => {
      const { executionId, userApprovalQuote, reason } = SCHEMA.parse(rawInput);

      const row = await CliExecution.findByPk(executionId);
      if (!row) {
        return `Error: cli_execution \`${executionId}\` not found. ` +
          `Double-check the id from the BUSY message.`;
      }

      // Authz: agent must own the row. Null agent_id (admin/system runs)
      // also can't be killed via this tool — those are surfaced to ops.
      if (row.agentId === null) {
        return (
          `Error: execution \`${executionId}\` was not started by an agent ` +
          `(invokedVia: ${row.invokedVia}). Only the admin who started it can kill it.`
        );
      }
      if (row.agentId !== callerAgentId) {
        return (
          `Error: execution \`${executionId}\` belongs to a different agent. ` +
          `You can only kill your own runs. If this is genuinely blocking your ` +
          `work, surface to the user and ask them to coordinate with the ` +
          `owning agent's user.`
        );
      }

      // Already finished — no-op, but reconcile the audit fields if needed.
      if (row.status !== "running") {
        return (
          `cli_execution \`${executionId}\` is already in status ` +
          `\`${row.status}\` — nothing to kill. ` +
          (row.sessionId
            ? `session_id was captured (${row.sessionId}); next run will --resume.`
            : `session_id was not captured.`)
        );
      }

      const adapter = getCliAdapter(row.provider);
      const baseMetadata = (row.providerMetadata ?? {}) as Record<
        string,
        unknown
      >;
      const killAuditFields = {
        killApprovalQuote: userApprovalQuote,
        killReason: reason ?? null,
        killedByAgentId: callerAgentId,
        killedAt: new Date().toISOString(),
      };

      // Engine never persisted a pid (extreme edge: row was created but the
      // pid update lost the race against worker death). Reconcile the row
      // to `killed` without sending a signal — there's nothing to signal.
      if (!row.pid) {
        await row.update({
          status: "killed",
          stderr: `killed by user approval (no pid persisted): ${userApprovalQuote}`,
          completedAt: new Date(),
          providerMetadata: {
            ...baseMetadata,
            ...killAuditFields,
            killReconciliation: "no_pid_persisted",
          },
        });
        logger.info("KillCliExecutionTool: reconciled row with no pid", {
          executionId,
          callerAgentId,
        });
        return (
          `cli_execution \`${executionId}\` had no pid persisted. ` +
          `Marked killed without sending a signal — there was nothing to kill.`
        );
      }

      // PID-recycle safety: verify the process at this pid is still our
      // CLI binary. If it's been recycled to something else, the original
      // CLI is already gone and we'd kill an unrelated process.
      let liveName: string | null;
      try {
        liveName = await readProcessName(row.pid);
      } catch (err: any) {
        logger.warn("KillCliExecutionTool: /proc read failed", {
          executionId,
          pid: row.pid,
          error: err?.message,
        });
        return (
          `Error: could not verify process at pid ${row.pid} (${err?.message ?? err}). ` +
          `Refusing to send a signal blind. Surface to ops.`
        );
      }

      if (liveName === null) {
        // Process is already gone — reconcile the row.
        await row.update({
          status: "killed",
          stderr: `process already exited; row reconciled. Approval: ${userApprovalQuote}`,
          completedAt: new Date(),
          providerMetadata: {
            ...baseMetadata,
            ...killAuditFields,
            killReconciliation: "process_already_exited",
          },
        });
        logger.info("KillCliExecutionTool: process already gone, row reconciled", {
          executionId,
          pid: row.pid,
        });
        return (
          `Process at pid ${row.pid} was already gone. ` +
          `cli_execution \`${executionId}\` marked killed.`
        );
      }

      if (liveName !== adapter.binary) {
        // PID was recycled to a different process (very rare on Linux, but
        // possible if the original CLI exited long ago and pids wrapped).
        // Mark our row killed but DO NOT signal.
        await row.update({
          status: "killed",
          stderr:
            `pid ${row.pid} is now '${liveName}', not '${adapter.binary}' — ` +
            `pid was recycled. Original process was already gone. ` +
            `Approval: ${userApprovalQuote}`,
          completedAt: new Date(),
          providerMetadata: {
            ...baseMetadata,
            ...killAuditFields,
            killReconciliation: "pid_recycled",
            recycledTo: liveName,
          },
        });
        logger.warn("KillCliExecutionTool: pid recycled, refused to signal", {
          executionId,
          pid: row.pid,
          expected: adapter.binary,
          live: liveName,
        });
        return (
          `Refused to signal pid ${row.pid}: it now belongs to ` +
          `'${liveName}', not '${adapter.binary}'. The original process is ` +
          `already gone. cli_execution \`${executionId}\` marked killed.`
        );
      }

      // Safe to signal. Send SIGTERM and update the row immediately — we
      // don't await the SIGKILL backstop before returning to the LLM, the
      // 10s wait would be a poor caller experience.
      try {
        process.kill(row.pid, "SIGTERM");
      } catch (err: any) {
        if (err?.code === "ESRCH") {
          // Disappeared between /proc check and signal.
          await row.update({
            status: "killed",
            stderr: `process disappeared during kill. Approval: ${userApprovalQuote}`,
            completedAt: new Date(),
            providerMetadata: {
              ...baseMetadata,
              ...killAuditFields,
              killReconciliation: "vanished_during_kill",
            },
          });
          return (
            `Process at pid ${row.pid} disappeared just as we tried to ` +
            `signal it. cli_execution \`${executionId}\` marked killed.`
          );
        }
        logger.error("KillCliExecutionTool: kill failed", {
          executionId,
          pid: row.pid,
          error: err?.message,
        });
        return (
          `Error: failed to send SIGTERM to pid ${row.pid}: ${err?.message ?? err}. ` +
          `Surface to ops — the row stays in 'running'.`
        );
      }

      // SIGKILL backstop: 10s grace, fire-and-forget. We re-verify the
      // process name to guard against the rare case of a same-binary pid
      // race in the gap.
      setTimeout(async () => {
        try {
          const stillThere = await readProcessName(row.pid as number);
          if (stillThere === adapter.binary) {
            try {
              process.kill(row.pid as number, "SIGKILL");
              logger.warn(
                "KillCliExecutionTool: SIGTERM ignored, sent SIGKILL backstop",
                { executionId, pid: row.pid },
              );
            } catch {
              // process disappeared between the recheck and the kill — fine
            }
          }
        } catch (err: any) {
          logger.warn("KillCliExecutionTool: backstop check failed", {
            executionId,
            error: err?.message,
          });
        }
      }, 10_000).unref();

      await row.update({
        status: "killed",
        stderr: `killed by user approval (SIGTERM sent, SIGKILL backstop in 10s): ${userApprovalQuote}`,
        completedAt: new Date(),
        providerMetadata: {
          ...baseMetadata,
          ...killAuditFields,
          killReconciliation: "sigterm_sent",
        },
      });

      logger.info("KillCliExecutionTool: SIGTERM sent", {
        executionId,
        callerAgentId,
        pid: row.pid,
        provider: row.provider,
        sessionId: row.sessionId,
      });

      return (
        `Killed cli_execution \`${executionId}\` (provider ${row.provider}, ` +
        `pid ${row.pid}). SIGTERM sent; SIGKILL will follow in 10s if it ` +
        `doesn't exit.\n\n` +
        (row.sessionId
          ? `session_id was captured: \`${row.sessionId}\`. The next ` +
            `\`run_${row.provider}_cli\` call from this thread will ` +
            `\`--resume\` from there and only bill the additional turns — ` +
            `you do not need to repeat the original prompt verbatim.`
          : `session_id was not captured (the kill happened before the CLI ` +
            `emitted its first event). The next run will start fresh — pay ` +
            `the full prompt cost.`)
      );
    },
    {
      name: "kill_cli_execution",
      description:
        "Abort a CLI subprocess (claude / codex) that you previously started " +
        "and is still running — typically because a worker crashed mid-run " +
        "and orphaned it. ONLY call this AFTER the user has explicitly " +
        "approved the abort. The `userApprovalQuote` argument must be the " +
        "user's verbatim words (NOT fabricated). You can only kill your own " +
        "runs, not another agent's. If the previous run captured a " +
        "session_id, the next `run_*_cli` call will `--resume` from where it " +
        "left off, so killing is not a full re-pay.",
      schema: SCHEMA,
    },
  );
}
