import { spawn, execSync, spawnSync } from "child_process";
import fs from "node:fs";
import { QueryTypes } from "sequelize";
import {
  sequelize,
  Project,
  Repository,
  EpicTask,
  EpicTaskRepository,
  TaskStage,
  AgentTask,
  TaskExecution,
  Agent,
} from "@scheduling-agent/database";
import type {
  UserId,
  AgentId,
  ProjectId,
  RepositoryId,
  EpicTaskId,
  AgentTaskId,
  TaskExecutionId,
  EpicTaskStatus,
  TaskStageStatus,
  TaskStageKind,
  AgentTaskStatus,
  TaskExecutionStatus,
  PrStatus,
} from "@scheduling-agent/types";
import { logger } from "../logger";
import {
  buildArchitectureOverviewPrompt,
  MAX_ARCHITECTURE_OVERVIEW_STORE_CHARS,
} from "../services/architectureOverviewPrompt";

// The agent_service container runs as root, but Claude CLI (and gh) must run
// as the non-root `agent` user via `su-exec`. `su-exec` inherits env unchanged,
// so HOME stays as /root — which means Claude CLI tries to write sessions,
// configs, and credentials under /root/.claude (not writable by agent).
// We explicitly override HOME so sessions land under /home/agent/.claude,
// where they can be inspected and `--resume` can find them.
const AGENT_HOME = "/home/agent";
const agentSpawnEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: AGENT_HOME,
});

/**
 * Run a git command in `cwd` as the non-root `agent` user via `su-exec`.
 *
 * Runtime git operations on epic repos (preExecutionSync, autoCreateStagePr,
 * autoPushToExistingPr) MUST go through this helper so that all files written
 * into `.git/` (FETCH_HEAD, ORIG_HEAD, index, logs/, refs/, objects/) stay
 * owned by `agent`. Otherwise the Claude CLI executor — which itself runs as
 * `agent` via `su-exec` and has to `git add` / `git commit` the task's work
 * before exiting — hits `error: cannot open '.git/index': Permission denied`,
 * the commit silently fails, and autoCreateStagePr ends up with zero commits
 * ahead of base. That is exactly the failure mode that left StocksScanner's
 * stage parked in `pr_pending` with NULL PR fields.
 *
 * Setup-time git calls in `repositories.service.ts` (clone, initial checkout,
 * workflow injection) are deliberately NOT routed through this helper —
 * they run as root and hand ownership over to `agent` once, via
 * `chownToAgent`, at the end of the setup phase.
 *
 * `HOME` is pinned to `/home/agent` so git uses the agent user's config and
 * credential helpers instead of root's (empty) ones.
 */
function gitAsAgent(
  cwd: string,
  args: string[],
  options: { timeoutMs?: number; maxBufferBytes?: number } = {},
): string {
  const { timeoutMs = 60_000, maxBufferBytes = 4 * 1024 * 1024 } = options;
  const result = spawnSync(
    "su-exec",
    ["agent", "git", ...args],
    {
      cwd,
      env: agentSpawnEnv(),
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: maxBufferBytes,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(
      `git ${args.join(" ")} exited with code ${result.status}${stderr ? `: ${stderr}` : ""}`,
    );
  }
  return (result.stdout ?? "").trim();
}

// ─── Project CRUD ────────────────────────────────────────────────────────────

export async function createProject(data: {
  name: string;
  description?: string;
  userId: UserId;
  metadata?: Record<string, unknown>;
}): Promise<Project> {
  return Project.create(data);
}

export async function getProject(projectId: ProjectId): Promise<Project | null> {
  return Project.findByPk(projectId, {
    include: [{ model: Repository, as: "repositories" }],
  });
}

export async function listProjects(filters: { userId?: UserId } = {}): Promise<Project[]> {
  const where: Record<string, unknown> = {};
  if (filters.userId) where.userId = filters.userId;
  return Project.findAll({ where, order: [["created_at", "DESC"]] });
}

// ─── Repository CRUD ─────────────────────────────────────────────────────────

export async function createRepository(
  projectId: ProjectId,
  data: {
    name: string;
    url: string;
    defaultBranch?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<Repository> {
  return Repository.create({ ...data, projectId });
}

// ─── Epic CRUD ───────────────────────────────────────────────────────────────

export async function getEpic(
  epicId: EpicTaskId,
  options: { includeStages?: boolean; includeTasks?: boolean } = {},
): Promise<EpicTask | null> {
  const include: any[] = [
    { model: Repository, as: "repositories" },
  ];

  if (options.includeStages || options.includeTasks) {
    const stageInclude: any[] = [];
    if (options.includeTasks) {
      stageInclude.push({
        model: AgentTask,
        as: "tasks",
        include: [
          { model: AgentTask, as: "dependencies" },
          { model: TaskExecution, as: "executions" },
        ],
      });
    }
    include.push({
      model: TaskStage,
      as: "stages",
      include: stageInclude,
      order: [["sort_order", "ASC"]],
    });
  }

  return EpicTask.findByPk(epicId, { include });
}

// ─── Task Executions ─────────────────────────────────────────────────────────

export async function startExecution(
  taskId: AgentTaskId,
  data: {
    cliSessionId?: string;
    prompt?: string;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<TaskExecution> {
  const lastExec = await TaskExecution.findOne({
    where: { agentTaskId: taskId },
    order: [["attempt_number", "DESC"]],
  });
  const attemptNumber = (lastExec?.attemptNumber ?? 0) + 1;

  return TaskExecution.create({
    agentTaskId: taskId,
    attemptNumber,
    cliSessionId: data.cliSessionId ?? null,
    prompt: data.prompt ?? null,
    metadata: data.metadata ?? null,
  });
}

export async function completeExecution(
  executionId: TaskExecutionId,
  data: { result: string; metadata?: Record<string, unknown> },
): Promise<TaskExecution> {
  const execution = await TaskExecution.findByPk(executionId);
  if (!execution) throw new Error(`Task execution ${executionId} not found`);

  const updates: Record<string, unknown> = {
    status: "completed" as TaskExecutionStatus,
    result: data.result,
    completedAt: new Date(),
  };
  if (data.metadata) {
    updates.metadata = { ...(execution.metadata ?? {}), ...data.metadata };
  }

  await execution.update(updates);
  return execution;
}

export async function failExecution(
  executionId: TaskExecutionId,
  data: { error: string; metadata?: Record<string, unknown> },
): Promise<TaskExecution> {
  const execution = await TaskExecution.findByPk(executionId);
  if (!execution) throw new Error(`Task execution ${executionId} not found`);

  const updates: Record<string, unknown> = {
    status: "failed" as TaskExecutionStatus,
    error: data.error,
    completedAt: new Date(),
  };
  if (data.metadata) {
    updates.metadata = { ...(execution.metadata ?? {}), ...data.metadata };
  }

  await execution.update(updates);
  return execution;
}

export async function prepareRetry(
  taskId: AgentTaskId,
  feedback: string,
): Promise<{
  previousSessionId: string | null;
  /** Continuation-style prompt — safe to use only with `--resume <previousSessionId>`. */
  resumePrompt: string;
  /** Standalone prompt — safe to use when starting a fresh CLI session with no prior memory. */
  freshPrompt: string;
}> {
  const task = await AgentTask.findByPk(taskId);
  const originalPrompt = task?.description ?? task?.title ?? "";

  const lastExec = await TaskExecution.findOne({
    where: { agentTaskId: taskId },
    order: [["attempt_number", "DESC"]],
  });
  const previousSessionId = lastExec?.cliSessionId ?? null;

  if (lastExec) {
    await lastExec.update({ feedback });
  }

  // Pull diff context from the previous execution (if any).
  let diffStat: string | undefined;
  let fullDiff: string | undefined;
  if (lastExec?.metadata) {
    const meta = lastExec.metadata as Record<string, unknown>;
    diffStat = meta.git_diff_stat as string | undefined;
    fullDiff = meta.git_diff as string | undefined;
  }

  // Truncate diff once for both prompt variants.
  const truncatedDiff =
    fullDiff && fullDiff.length > 20000
      ? fullDiff.slice(0, 20000) + "\n\n... (diff truncated)"
      : fullDiff;

  // ── Resume prompt ──
  // Used ONLY when we successfully resume the previous Claude CLI session.
  // The session already contains the original task description, the model's
  // prior turns, and the tool outputs, so the wording is second-person
  // ("you previously changed...") and does not restate the task.
  //
  // Important — the prior turns may have ended with the model believing the
  // task was complete. A gentle "fix the issues" wrapper is read as a
  // follow-up question and the model summarizes prior work instead of
  // re-executing it (root cause of the "CLI ignores the path" symptom on
  // retries — see attempt #4 trace, 2026-04-25). The wrapper below makes the
  // re-execution requirement explicit and forbids "summarize what I did" as
  // a valid reply.
  const directiveTail =
    "\n## This is a re-execution, not a follow-up question\n" +
    "The orchestrator rejected your previous outcome. **The task is NOT complete.** You must re-run " +
    "the actual work via tool calls (write_file / edit / bash / etc.), not just describe, summarize, " +
    "or apologize for what you did before.\n\n" +
    "Concretely:\n" +
    "- Treat anything the previous attempt claimed to deliver as **not delivered** until you have a " +
    "fresh tool result confirming it in this turn.\n" +
    "- If the feedback names a specific output path, file, or behavior, **call the corresponding tool " +
    "again now** to produce it — even if you remember writing it before. Permissions or paths that " +
    "previously failed may have been fixed since.\n" +
    "- If a prior write fell back to an alternate location because the original target wasn't " +
    "writable, redo the write at the **originally-requested path**. Don't assume the previous failure " +
    "still applies — verify with a tool call.\n" +
    "- Your session memory (file reads, prior tool outputs, reasoning) is preserved so you can be " +
    "efficient — use it as context, then finish the work.\n" +
    "- A reply that only restates what you did in earlier turns will be rejected as another empty " +
    "completion. Re-execute, then report what the new tool calls actually returned.";

  let resumePrompt = feedback + directiveTail;
  if (diffStat || truncatedDiff) {
    resumePrompt = `## Feedback from Orchestrator\n\n${feedback}\n`;
    if (diffStat) {
      resumePrompt += `\n## Files You Changed (from previous attempt)\n\`\`\`\n${diffStat}\n\`\`\`\n`;
    }
    if (truncatedDiff) {
      resumePrompt += `\n## Your Previous Diff\n\`\`\`diff\n${truncatedDiff}\n\`\`\`\n`;
    }
    resumePrompt += directiveTail;
  }

  // ── Fresh prompt ──
  // Used when the previous CLI session is gone (not found, expired, or never
  // persisted). The new session has NO memory of the prior attempt, so we
  // must restate the original task and frame the previous attempt in
  // third-person ("a previous attempt...") with an explicit note that the
  // model is not resuming its own prior work.
  const freshPromptParts: string[] = [];
  if (originalPrompt) {
    freshPromptParts.push(originalPrompt);
  }
  freshPromptParts.push(
    "---",
    "## Note — Fresh Session",
    "A previous attempt at this task was made in a different Claude CLI session, but that session is not available to resume. You are starting fresh and do NOT have memory of the previous attempt. Treat the original task above as your primary instructions, and use the context below (reviewer feedback and the prior diff) as reference for what was already tried and what still needs to change.",
    "",
    "## Reviewer Feedback on the Previous Attempt",
    feedback,
  );
  if (diffStat) {
    freshPromptParts.push(
      "",
      "## Files Changed in the Previous Attempt",
      "```",
      diffStat,
      "```",
    );
  }
  if (truncatedDiff) {
    freshPromptParts.push(
      "",
      "## Previous Attempt Diff (for reference)",
      "```diff",
      truncatedDiff,
      "```",
    );
  }
  freshPromptParts.push(
    "",
    "Implement the task per the original instructions above. Apply the reviewer feedback. The previous diff is provided only as context — you may build on it, correct it, or rewrite it, whichever produces a correct implementation.",
  );
  const freshPrompt = freshPromptParts.join("\n");

  await AgentTask.update(
    { status: "in_progress" as AgentTaskStatus, completedAt: null },
    { where: { id: taskId } },
  );

  return { previousSessionId, resumePrompt, freshPrompt };
}

// ─── Dependency Resolution ───────────────────────────────────────────────────

export async function getReadyTasks(epicId: EpicTaskId): Promise<AgentTask[]> {
  const results = await sequelize.query<AgentTask>(
    `SELECT at.*
     FROM agent_tasks at
     JOIN task_stages ts ON at.task_stage_id = ts.id
     WHERE ts.epic_task_id = :epicId
       AND at.status = 'ready'
       -- Block if ANY earlier stage is not completed, OR — for code_change
       -- stages — its PR is not approved/merged. Plan stages skip the
       -- pr_status check entirely: they never produce a PR, so once the
       -- stage is 'completed' the gate is cleared.
       AND NOT EXISTS (
         SELECT 1
         FROM task_stages prev_stage
         WHERE prev_stage.epic_task_id = ts.epic_task_id
           AND prev_stage.sort_order < ts.sort_order
           AND (
             prev_stage.status <> 'completed'
             OR (
               prev_stage.kind = 'code_change'
               AND COALESCE(prev_stage.pr_status, 'none') NOT IN ('approved', 'merged')
             )
           )
       )
     ORDER BY ts.sort_order, at.sort_order`,
    {
      replacements: { epicId },
      type: QueryTypes.SELECT,
    },
  );
  return results;
}

/**
 * Flip the next stage's `pending` agent tasks to `ready` once their preceding
 * stages are all cleared (completed AND, for code_change stages, PR
 * approved/merged), and run `propagateStatus` once so the next stage's
 * derived status (`pending` → `in_progress`) catches up immediately rather
 * than waiting for `executeTask` to start the first task.
 *
 * Single source of truth shared by:
 *   - `propagateStatus` auto-completion of `kind='plan'` stages
 *   - `approve_stage` no-PR branch
 *   - `EpicTaskService.handlePrApproval` (PR-approved branch)
 *
 * Returns the agent task IDs that were promoted to `ready` so callers can
 * surface a "N task(s) unblocked" message and decide whether to enqueue an
 * orchestrator continuation.
 */
export async function advanceNextStageReadyTasks(
  epicId: EpicTaskId,
): Promise<AgentTaskId[]> {
  const newlyReady = await sequelize.query<AgentTask>(
    `SELECT at.*
       FROM agent_tasks at
       JOIN task_stages ts ON at.task_stage_id = ts.id
      WHERE ts.epic_task_id = :epicId
        AND at.status = 'pending'
        AND NOT EXISTS (
          SELECT 1
          FROM task_stages prev_stage
          WHERE prev_stage.epic_task_id = ts.epic_task_id
            AND prev_stage.sort_order < ts.sort_order
            AND (
              prev_stage.status <> 'completed'
              OR (
                prev_stage.kind = 'code_change'
                AND COALESCE(prev_stage.pr_status, 'none') NOT IN ('approved', 'merged')
              )
            )
        )
      ORDER BY ts.sort_order, at.sort_order`,
    { replacements: { epicId }, type: QueryTypes.SELECT },
  );

  if (newlyReady.length === 0) return [];

  const ids = newlyReady.map((t) => t.id);
  await AgentTask.update(
    { status: "ready" as AgentTaskStatus },
    { where: { id: ids } },
  );

  // One propagateStatus call is enough: it recomputes the touched task's
  // stage and the epic. If the unblocked tasks span multiple stages (rare —
  // requires consecutive plan stages with empty task lists), the SQL pulls
  // them ordered by sort_order so the first ID belongs to the earliest stage,
  // and subsequent stages will be picked up the next time any task in them
  // moves through updateTaskStatus.
  try {
    await propagateStatus(ids[0]);
  } catch (err: any) {
    logger.warn("advanceNextStageReadyTasks: propagateStatus failed (status will catch up on next task transition)", {
      epicId,
      taskId: ids[0],
      error: err?.message,
    });
  }

  return ids;
}

// ─── Active-state Resolvers ────────────────────────────────────────────────
//
// The Epic Orchestrator is a system-wide singleton: at any moment the DB
// contains at most one epic with status IN ('pending','in_progress'), and
// within that epic the sequential-stage invariant guarantees that at most
// one stage is currently advanceable (in_progress or pr_pending). Given
// those two invariants, every "which epic/stage do you mean?" question has
// exactly one correct answer that can be computed from state.
//
// Tools use these helpers instead of accepting IDs as inputs so the model
// can't hallucinate a UUID field that doesn't exist in the schema. The
// helpers throw loudly (never silently pick a "close enough" row) so the
// caller gets an actionable error.

/**
 * Returns the unique active (pending or in_progress) epic.
 * Throws a descriptive error if there are zero or more-than-one.
 */
export async function resolveActiveEpic(): Promise<EpicTask> {
  const active = await EpicTask.findAll({
    where: { status: ["pending" as EpicTaskStatus, "in_progress" as EpicTaskStatus] },
    order: [["createdAt", "DESC"]],
  });
  if (active.length === 0) {
    throw new Error(
      "No active epic. The epic orchestrator is a system-wide singleton — " +
      "create one with create_epic_plan before calling this tool.",
    );
  }
  if (active.length > 1) {
    // This violates the singleton invariant enforced by CreateEpicPlanTool.
    // Surface it loudly — it means the DB state is inconsistent.
    throw new Error(
      `Invariant violated: ${active.length} active epics found (expected 1). ` +
      `IDs: ${active.map((e) => e.id).join(", ")}. ` +
      `Manually resolve this before continuing.`,
    );
  }
  return active[0];
}

/**
 * Returns the next task the orchestrator should operate on in the active
 * epic — without accepting any IDs from the caller.
 *
 * Resolution order:
 * 1. The first task with status = 'ready' (handles the normal execution flow
 *    and the post-`request_stage_changes` retry flow, where tasks were just
 *    reset back to 'ready').
 * 2. The first task with status = 'failed' in a stage whose status is still
 *    'in_progress' (handles mid-stage failures, where a CLI error or timeout
 *    left the stage stuck — there would be nothing 'ready' because the next
 *    task is still 'pending' behind the failed one in sort order).
 *
 * Returns null only if both queries are empty, which genuinely means there
 * is nothing to do (stage is done, epic is waiting for PR approval, etc.).
 *
 * `prepareRetry` handles resetting a failed task's status back to
 * 'in_progress' on the retry path, so callers don't need to mutate it here.
 */
export async function resolveNextRetryableTask(
  epicId: EpicTaskId,
): Promise<AgentTask | null> {
  const ready = await getReadyTasks(epicId);
  if (ready.length > 0) return ready[0];

  const failed = await sequelize.query<AgentTask>(
    `SELECT at.*
       FROM agent_tasks at
       JOIN task_stages ts ON at.task_stage_id = ts.id
      WHERE ts.epic_task_id = :epicId
        AND ts.status = 'in_progress'
        AND at.status = 'failed'
      ORDER BY ts.sort_order, at.sort_order
      LIMIT 1`,
    { replacements: { epicId }, type: QueryTypes.SELECT },
  );
  return failed[0] ?? null;
}

/**
 * Resolve a stage's position within its epic — `index` is 1-based for human
 * messaging ("Stage 3 of 5"), `total` is the count of stages in the epic,
 * and `isLast` is true when the stage's `sortOrder` is the maximum among
 * its siblings. Used by `appendContinuationMarker` and
 * `formatReviewActionForCompletedTask` so the "approve to start the next
 * stage" prompt only fires when a next stage actually exists — and the
 * final-stage message correctly tells the user "approving completes the
 * epic" instead of inventing a phantom stage.
 *
 * Returns null on lookup failure so callers can degrade gracefully to the
 * generic "next stage" wording rather than throwing on a transient DB
 * issue.
 */
async function resolveStagePosition(
  stage: { id: string; epicTaskId: EpicTaskId; sortOrder: number },
): Promise<{ index: number; total: number; isLast: boolean } | null> {
  try {
    const siblings = await TaskStage.findAll({
      where: { epicTaskId: stage.epicTaskId },
      attributes: ["id", "sortOrder"],
      order: [["sortOrder", "ASC"]],
    });
    if (siblings.length === 0) return null;
    const total = siblings.length;
    const idx = siblings.findIndex((s) => s.id === stage.id);
    if (idx < 0) return null;
    return {
      index: idx + 1,
      total,
      isLast: idx === siblings.length - 1,
    };
  } catch {
    return null;
  }
}

/**
 * Returns the unique stage of the active epic that is currently awaiting
 * PR approval (status = 'pr_pending'). Throws if there are zero or >1.
 * Used by request_stage_changes, approve_stage, force_approve_stage_pr.
 */
export async function resolveActivePrPendingStage(): Promise<{
  epic: EpicTask;
  stage: TaskStage;
}> {
  const epic = await resolveActiveEpic();
  const stages = await TaskStage.findAll({
    where: { epicTaskId: epic.id, status: "pr_pending" as TaskStageStatus },
    include: [{ model: AgentTask, as: "tasks" }],
    order: [["sortOrder", "ASC"]],
  });
  if (stages.length === 0) {
    throw new Error(
      `No stage is currently awaiting review in epic "${epic.title}". ` +
      `Call get_epic_status to see the current state of the epic.`,
    );
  }
  if (stages.length > 1) {
    // Violates the sequential-stage invariant (getReadyTasks SQL), so surface it.
    throw new Error(
      `Invariant violated: ${stages.length} stages are in pr_pending in epic "${epic.title}" ` +
      `(expected 1). IDs: ${stages.map((s) => s.id).join(", ")}.`,
    );
  }
  return { epic, stage: stages[0] };
}

// ─── Status Propagation ─────────────────────────────────────────────────────

export async function propagateStatus(taskId: AgentTaskId): Promise<void> {
  const task = await AgentTask.findByPk(taskId);
  if (!task) return;

  // Propagate to stage. Plan stages park at `pr_pending` exactly like
  // code-change stages so the user can review the produced plan/spec before
  // explicitly approving it via `approve_stage` — auto-completing plan stages
  // would skip review. The only difference is in the gating predicate
  // (see `getReadyTasks` SQL): a `kind='plan'` previous stage clears as soon
  // as it's `status='completed'`, without requiring `pr_status` because no
  // PR ever exists.
  const stageTasks = await AgentTask.findAll({
    where: { taskStageId: task.taskStageId },
  });

  const stageStatuses = stageTasks.map((t) => t.status);
  let newStageStatus: TaskStageStatus;

  if (stageStatuses.every((s) => s === "completed")) {
    // All tasks done — wait for explicit user approval (PR for code_change,
    // chat-confirmation for plan) before becoming "completed".
    newStageStatus = "pr_pending";
  } else if (stageStatuses.some((s) => s === "failed")) {
    newStageStatus = "failed";
  } else if (stageStatuses.some((s) => s === "in_progress" || s === "ready")) {
    newStageStatus = "in_progress";
  } else {
    newStageStatus = "pending";
  }

  await TaskStage.update({ status: newStageStatus }, { where: { id: task.taskStageId } });

  // Propagate to epic — never mark epic completed here;
  // epic completion is handled by handlePrApproval / force_approve_stage_pr
  const stage = await TaskStage.findByPk(task.taskStageId);
  if (!stage) return;

  const epicStages = await TaskStage.findAll({
    where: { epicTaskId: stage.epicTaskId },
  });

  const epicStatuses = epicStages.map((s) => s.status);
  let newEpicStatus: EpicTaskStatus;

  if (epicStatuses.some((s) => s === "failed")) {
    newEpicStatus = "failed";
  } else if (epicStatuses.some((s) => s === "in_progress" || s === "pr_pending")) {
    newEpicStatus = "in_progress";
  } else if (epicStatuses.every((s) => s === "completed")) {
    // All stages completed (which only happens after PR approval) — epic is done
    newEpicStatus = "completed";
  } else {
    newEpicStatus = "pending";
  }

  const epicUpdates: Record<string, unknown> = { status: newEpicStatus };
  if (newEpicStatus === "completed") {
    epicUpdates.completedAt = new Date();
  }
  await EpicTask.update(epicUpdates, { where: { id: stage.epicTaskId } });
}

// ─── Update Task Status ──────────────────────────────────────────────────────

export async function updateTaskStatus(taskId: AgentTaskId, status: AgentTaskStatus): Promise<AgentTask> {
  const task = await AgentTask.findByPk(taskId);
  if (!task) throw new Error(`Agent task ${taskId} not found`);

  const updates: Partial<{ status: AgentTaskStatus; startedAt: Date | null; completedAt: Date | null }> = { status };

  if (status === "in_progress" && !task.startedAt) {
    updates.startedAt = new Date();
  }
  if (status === "completed" || status === "failed") {
    updates.completedAt = new Date();
  }

  await task.update(updates);
  await propagateStatus(taskId);
  return task;
}

// ─── Git Diff Capture ───────────────────────────────────────────────────────

export interface GitDiffResult {
  diffStat: string;
  fullDiff: string;
  recentCommits: string;
}

/**
 * Captures a git diff summary for a task execution.
 *
 * The `baseSha` argument is the critical piece: it should be the commit SHA
 * that HEAD pointed at **before** the CLI ran. When provided, we diff the
 * working tree against that snapshot — which naturally includes any commits
 * the CLI made *and* any leftover uncommitted changes in one shot. Without a
 * baseSha, the function degrades to `git diff HEAD`, which only shows
 * uncommitted changes and will be empty whenever the CLI (or our safety-net
 * auto-commit) already committed everything — the very case that produced
 * empty `git_diff` / `git_diff_stat` fields in task_executions records.
 */
export function captureGitDiff(cwd: string, baseSha?: string | null): GitDiffResult {
  const execOpts = { cwd, encoding: "utf-8" as const, maxBuffer: 2 * 1024 * 1024 };
  // When we have a pre-run snapshot, diff against it — this captures committed
  // *and* uncommitted changes introduced since the CLI started. Otherwise fall
  // back to HEAD (which only works for uncommitted changes — the broken path).
  const baseRef = baseSha && baseSha.length > 0 ? baseSha : "HEAD";

  let diffStat = "";
  let fullDiff = "";
  let recentCommits = "";

  try {
    diffStat = execSync(`git diff --stat ${baseRef}`, execOpts).trim();
    // Fallback for the (non-snapshot) case: if nothing against HEAD, try the
    // working tree only. Harmless when baseSha is provided — diff against a
    // real SHA would already have returned a result if there was one.
    if (!diffStat) {
      diffStat = execSync("git diff --stat", execOpts).trim();
    }
  } catch {
    try {
      diffStat = execSync("git diff --stat", execOpts).trim();
    } catch {
      diffStat = "(unable to capture diff stat)";
    }
  }

  try {
    // Full diff — cap at 50k chars to avoid blowing up context
    const raw = execSync(`git diff ${baseRef}`, execOpts).trim();
    fullDiff = raw.length > 50000
      ? raw.slice(0, 50000) + "\n\n... (diff truncated at 50,000 chars)"
      : raw;
    if (!fullDiff) {
      const rawWt = execSync("git diff", execOpts).trim();
      fullDiff = rawWt.length > 50000
        ? rawWt.slice(0, 50000) + "\n\n... (diff truncated at 50,000 chars)"
        : rawWt;
    }
  } catch {
    try {
      const rawWt = execSync("git diff", execOpts).trim();
      fullDiff = rawWt.length > 50000
        ? rawWt.slice(0, 50000) + "\n\n... (diff truncated at 50,000 chars)"
        : rawWt;
    } catch {
      fullDiff = "(unable to capture full diff)";
    }
  }

  try {
    recentCommits = execSync("git log --oneline -5", execOpts).trim();
  } catch {
    recentCommits = "(unable to capture recent commits)";
  }

  return { diffStat, fullDiff, recentCommits };
}

/**
 * Computes the **stage-level** diff — from the commit SHA the stage branch
 * was rooted at (captured by `preExecutionSync` at branch creation) to the
 * current HEAD on that stage branch. This is the diff a human reviewer cares
 * about: "what did this whole stage change, treating it as one unit of
 * work" — independent of how many tasks the planner decomposed it into.
 *
 * Distinct from `captureGitDiff`, which is per-task-execution and scoped to
 * a single `executeTask` run (using a snapshot taken moments before the CLI
 * spawned). Per-task diffs are for audit and `review_task_diff`;
 * `captureStageDiff` is for user-facing stage review, PR descriptions, and
 * `get_epic_status` output.
 *
 * Returns `null` (not throws) for every "no diff to compute" case so callers
 * can surface "stage not started yet" or "no stage repo" without special
 * error handling. A genuine git failure still throws.
 */
export async function captureStageDiff(
  stage: TaskStage,
): Promise<GitDiffResult | null> {
  if (!stage.baseCommitSha || !stage.repositoryId) return null;

  const repo = await Repository.findByPk(stage.repositoryId);
  if (!repo?.localPath) return null;

  // Reuse captureGitDiff with the stage's baseline SHA. It already handles
  // the stat + full diff + recent commits shape we want, diff'ing the
  // current working tree (= stage branch tip, after all tasks committed)
  // against the captured base.
  return captureGitDiff(repo.localPath, stage.baseCommitSha);
}

// ─── Pre-Execution Sync ─────────────────────────────────────────────────────

/**
 * Builds a deterministic feature branch name for a stage. The name is
 * reproducible from the epic/stage IDs so retries of the same stage always
 * resolve to the same branch, and descriptive enough for a human reviewer
 * to recognize in the PR list.
 */
/**
 * Safety net for the success path of `executeTask`: if the Claude CLI exited
 * cleanly but left uncommitted changes in the working tree (e.g. it forgot the
 * explicit commit instruction from the architecture context), stage and commit
 * everything under the `agent` user so the stage's PR push has commits to
 * deliver. Returns `{ committed: false }` if the tree was already clean.
 *
 * All git commands run via `su-exec agent` with HOME pinned to `/home/agent`
 * to match how the Claude CLI itself is invoked — otherwise git's
 * `safe.directory` / ownership checks trip on files just written by `agent`.
 */
function ensureWorkingTreeCommitted(
  cwd: string,
  taskTitle: string,
): { committed: boolean; message?: string } {
  const statusResult = spawnSync(
    "su-exec",
    ["agent", "git", "status", "--porcelain"],
    { cwd, env: agentSpawnEnv(), encoding: "utf-8", timeout: 30_000 },
  );
  if (statusResult.status !== 0) {
    throw new Error(
      statusResult.stderr?.trim() ||
        `git status exited with code ${statusResult.status}`,
    );
  }
  const dirty = (statusResult.stdout ?? "").trim().length > 0;
  if (!dirty) return { committed: false };

  const addResult = spawnSync(
    "su-exec",
    ["agent", "git", "add", "-A"],
    { cwd, env: agentSpawnEnv(), encoding: "utf-8", timeout: 60_000 },
  );
  if (addResult.status !== 0) {
    throw new Error(
      addResult.stderr?.trim() ||
        `git add exited with code ${addResult.status}`,
    );
  }

  // Short, English-only auto-commit message — mirrors the rule we enforce on
  // the executor. Keep it prefixed so auditors can tell auto-commits apart
  // from executor-authored ones.
  const cleanTitle = (taskTitle || "agent task")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const message = `auto: ${cleanTitle}`;

  const commitResult = spawnSync(
    "su-exec",
    ["agent", "git", "commit", "-m", message],
    { cwd, env: agentSpawnEnv(), encoding: "utf-8", timeout: 60_000 },
  );
  if (commitResult.status !== 0) {
    // "nothing to commit" can race with the status check if the CLI was still
    // flushing — treat as non-committed rather than hard-failing.
    const stderr = commitResult.stderr?.trim() ?? "";
    if (/nothing to commit/i.test(stderr)) {
      return { committed: false };
    }
    throw new Error(stderr || `git commit exited with code ${commitResult.status}`);
  }

  return { committed: true, message };
}

function buildStageBranchName(epic: EpicTask, stage: TaskStage): string {
  const shortEpicId = epic.id.slice(0, 8);
  const slug = (stage.title || `stage-${stage.sortOrder}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "stage";
  return `epic/${shortEpicId}-s${stage.sortOrder}-${slug}`;
}

/**
 * Runs before each task execution to ensure repos are up-to-date and
 * architecture descriptions still match reality.
 *
 * `taskId` is REQUIRED: every real call site in the epic pipeline has a
 * concrete task to sync for, and the stage-branch-creation logic only works
 * when we can resolve the task → stage → repository chain. Making this
 * parameter optional used to silently degrade the function into a generic
 * "pull default branch for every repo" mode — which reintroduces the exact
 * bug this whole branch-selection logic was added to fix. A future caller
 * that legitimately wants to refresh repos without a task should build a
 * dedicated helper instead of smuggling `undefined` through here.
 *
 * Branch-selection rules (per repository):
 *   • If the current task's stage already has `branchName` set (either from a
 *     previous task in the same stage creating it, or from a PR already
 *     opened), the stage's primary repo fetches and syncs onto that branch.
 *   • If the stage does NOT yet have a branch AND we have a primary repo,
 *     this is the first task of the stage — we check out the repo's default
 *     branch, pull latest, then `git switch -c` a new feature branch for the
 *     stage and persist it on `stage.branchName` + `stage.repositoryId` so
 *     every subsequent task in the same stage (and any retries) lands on the
 *     same branch.
 *   • Other repos in the same epic (non-primary) always pull their default
 *     branch.
 *
 * Architecture overviews are NOT refreshed here — that happens once per epic,
 * at plan-creation time, against each repo's DEFAULT branch (see
 * `refreshArchitectureOverviewOnDefault`). Refreshing here would risk writing
 * back an overview derived from an unmerged stage branch that may be
 * abandoned or rewritten.
 */
export async function preExecutionSync(
  epicId: EpicTaskId,
  taskId: AgentTaskId,
): Promise<void> {
  const epic = await EpicTask.findByPk(epicId, {
    include: [{ model: Repository, as: "repositories" }],
  });
  if (!epic) return;

  const repos = ((epic as any).repositories ?? []) as Repository[];
  if (repos.length === 0) return;

  // Resolve the stage and decide which repo is the stage's primary. A stage's
  // primary repo is the one its feature branch lives on and the one the PR
  // is opened against. We prefer an explicit `stage.repositoryId` (set as
  // soon as the first task creates the branch), and fall back to the first
  // repo with a localPath for brand-new stages in single-repo epics.
  const task = await AgentTask.findByPk(taskId, {
    include: [{ model: TaskStage, as: "stage" }],
  });
  if (!task) {
    throw new Error(
      `preExecutionSync: agent task ${taskId} not found — cannot resolve stage for branch selection`,
    );
  }
  const stage = ((task as any)?.stage as TaskStage | undefined) ?? null;
  if (!stage) {
    throw new Error(
      `preExecutionSync: agent task ${taskId} has no parent stage — refusing to sync without a stage context`,
    );
  }
  const primaryRepoId: string | null =
    stage.repositoryId ?? repos.find((r) => r.localPath)?.id ?? null;

  // If the stage is on its first task (no branch yet), create one FROM the
  // primary repo's default branch BEFORE looping over repos — so the main
  // sync loop below sees `stage.branchName` populated and checks out the
  // new branch instead of leaving us on the default branch.
  if (!stage.branchName && primaryRepoId) {
    const primaryRepo = repos.find((r) => r.id === primaryRepoId);
    if (primaryRepo?.localPath) {
      const cwd = primaryRepo.localPath;
      const defaultBranch = primaryRepo.defaultBranch || "main";
      const newBranch = buildStageBranchName(epic, stage);
      try {
        gitAsAgent(cwd, ["fetch", "origin"]);
        // Start FROM the default branch so the new feature branch is rooted
        // at the latest default-branch tip.
        try {
          gitAsAgent(cwd, ["switch", defaultBranch]);
        } catch {
          gitAsAgent(cwd, ["checkout", "-B", defaultBranch, `origin/${defaultBranch}`]);
        }
        gitAsAgent(cwd, ["pull", "origin", defaultBranch]);
        // Create (or reset to tip) the stage branch. `-B` fallback is used so
        // that if a prior aborted run left the branch lying around locally,
        // we reset it cleanly to the current default-branch tip instead of
        // failing with "already exists".
        try {
          gitAsAgent(cwd, ["switch", "-c", newBranch]);
        } catch {
          gitAsAgent(cwd, ["checkout", "-B", newBranch]);
        }
        // Capture the stage's baseline commit SHA — this is HEAD right after
        // the branch was rooted at the default-branch tip, before any task
        // has run. It's the anchor for the stage-level diff the user reviews
        // ("did the agent do what I asked?"). Captured once, never updated.
        // If this fails we log and proceed — stage execution is more
        // important than the diff anchor, and retries will be caught by the
        // per-task diffs we already capture.
        let baseCommitSha: string | null = null;
        try {
          baseCommitSha = gitAsAgent(cwd, ["rev-parse", "HEAD"]) || null;
        } catch (shaErr) {
          logger.warn("preExecutionSync: failed to snapshot stage base SHA", {
            epicId,
            stageId: stage.id,
            branch: newBranch,
            error: shaErr instanceof Error ? shaErr.message : String(shaErr),
          });
        }
        await stage.update({
          branchName: newBranch,
          repositoryId: primaryRepo.id,
          baseCommitSha,
        });
        // Mutate the in-memory stage so the sync loop below uses the new value.
        stage.branchName = newBranch;
        stage.repositoryId = primaryRepo.id as any;
        stage.baseCommitSha = baseCommitSha;
        logger.info("preExecutionSync: created stage branch", {
          epicId,
          stageId: stage.id,
          repoId: primaryRepo.id,
          branch: newBranch,
          fromDefault: defaultBranch,
          baseCommitSha,
        });
      } catch (err) {
        logger.error("preExecutionSync: failed to create stage branch", {
          epicId,
          stageId: stage.id,
          branch: newBranch,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const stageBranchName = stage.branchName ?? null;
  const stageBranchRepoId = stage.branchName ? primaryRepoId : null;

  for (const repo of repos) {
    if (!repo.localPath) continue;

    const cwd = repo.localPath;
    const defaultBranch = repo.defaultBranch || "main";

    const useStageBranch =
      stageBranchName !== null && repo.id === stageBranchRepoId;
    const targetBranch = useStageBranch ? stageBranchName! : defaultBranch;

    // ── 1. Fetch + checkout + pull the correct branch ──
    try {
      gitAsAgent(cwd, ["fetch", "origin"]);

      let currentBranch = "";
      try {
        currentBranch = gitAsAgent(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
      } catch {
        currentBranch = "";
      }

      if (currentBranch !== targetBranch) {
        try {
          gitAsAgent(cwd, ["switch", targetBranch]);
        } catch {
          gitAsAgent(cwd, ["checkout", "-B", targetBranch, `origin/${targetBranch}`]);
        }
      }

      // Only pull from origin if the branch already exists there. A brand-new
      // stage branch we just created locally has no remote counterpart yet,
      // and `git pull origin <newBranch>` would error.
      const hasRemote = (() => {
        try {
          gitAsAgent(cwd, ["rev-parse", "--verify", `origin/${targetBranch}`]);
          return true;
        } catch {
          return false;
        }
      })();

      if (hasRemote) {
        gitAsAgent(cwd, ["pull", "origin", targetBranch]);
      }

      logger.info("preExecutionSync: synced repo", {
        repoId: repo.id,
        branch: targetBranch,
        usedStageBranch: useStageBranch,
        hasRemote,
      });
    } catch (err) {
      // Non-fatal — repo may have no upstream, diverged, or have local changes.
      logger.warn("preExecutionSync: git sync failed", {
        repoId: repo.id,
        branch: targetBranch,
        usedStageBranch: useStageBranch,
        error: err instanceof Error ? err.message : String(err),
      });
    }

  }
}

// ─── Architecture Overview Refresh ──────────────────────────────────────────

/**
 * Spawns a quick Claude CLI call to analyze the repo at `cwd` and produce a
 * concise architecture overview, then persists it to the repository record.
 *
 * The caller is responsible for checking out the correct branch before
 * invoking — the CLI just reads the working tree as it finds it. In practice
 * this is always the repo's default branch, so the stored overview describes
 * the canonical/merged state of the repo.
 */
async function generateArchitectureOverview(
  repo: Repository,
  cwd: string,
): Promise<void> {
  const currentOverview = repo.architectureOverview?.trim() || "(none)";
  const prompt = buildArchitectureOverviewPrompt(currentOverview);

  try {
    const cliResult = spawnSync("su-exec", [
      "agent", "claude",
      "-p", prompt,
      "--dangerously-skip-permissions",
      "--max-turns", "35",
    ], {
      cwd,
      env: agentSpawnEnv(),
      encoding: "utf-8",
      timeout: 600_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (cliResult.error) throw cliResult.error;
    if (cliResult.status !== 0) {
      throw new Error(cliResult.stderr?.trim() || `claude exited with code ${cliResult.status}`);
    }
    const result = (cliResult.stdout ?? "").trim();

    if (result && result.length > 20) {
      const stored =
        result.length > MAX_ARCHITECTURE_OVERVIEW_STORE_CHARS
          ? result.slice(0, MAX_ARCHITECTURE_OVERVIEW_STORE_CHARS)
          : result;
      const previous = repo.architectureOverview;
      await repo.update({ architectureOverview: stored });
      logger.info("generateArchitectureOverview: updated architecture overview", {
        repoId: repo.id,
        repoName: repo.name,
        previousLength: previous?.length ?? 0,
        newLength: stored.length,
      });
    }
  } catch (err) {
    logger.warn("generateArchitectureOverview: Claude CLI architecture analysis failed", {
      repoId: repo.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Checks out the repo's default branch, pulls the latest, and refreshes
 * `repo.architectureOverview` if the repo has drifted (or has no overview yet).
 *
 * Call this once per epic, at plan-creation time — NOT per task. The stored
 * overview must always describe the merged/canonical state of the repo, so we
 * must analyze it on the default branch, never on a speculative stage branch
 * that may be abandoned or rewritten during review.
 *
 * Concurrency: safe to call from `createEpicWithPlan` because the epic
 * orchestrator enforces a system-wide "one active epic at a time" invariant
 * (see `CreateEpicPlanTool`), so no executing task can be holding the repo's
 * working tree on another branch when this runs.
 *
 * Non-fatal: git or CLI hiccups are logged and swallowed so epic creation
 * is never blocked on architecture refresh.
 */
export async function refreshArchitectureOverviewOnDefault(
  repo: Repository,
): Promise<void> {
  if (!repo.localPath) return;

  const cwd = repo.localPath;
  const defaultBranch = repo.defaultBranch || "main";

  // ── 1. Put the working tree on the default branch ──
  try {
    gitAsAgent(cwd, ["fetch", "origin"]);
    try {
      gitAsAgent(cwd, ["switch", defaultBranch]);
    } catch {
      gitAsAgent(cwd, ["checkout", "-B", defaultBranch, `origin/${defaultBranch}`]);
    }
    gitAsAgent(cwd, ["pull", "origin", defaultBranch]);
  } catch (err) {
    logger.warn("refreshArchitectureOverviewOnDefault: git sync failed", {
      repoId: repo.id,
      defaultBranch,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // ── 2. Detect structural changes ──
  try {
    const hasArchitecture = !!repo.architectureOverview?.trim();

    let diffNameOnly = "";
    try {
      diffNameOnly = gitAsAgent(cwd, [
        "log",
        "--name-status",
        "--diff-filter=ADRT",
        "--pretty=format:",
        "-20",
      ]);
    } catch {
      try {
        diffNameOnly = gitAsAgent(cwd, ["diff", "--name-status", "HEAD~10", "HEAD"]);
      } catch {
        // Repo may have <10 commits — nothing to compare against.
        if (!hasArchitecture) {
          await generateArchitectureOverview(repo, cwd);
        }
        return;
      }
    }

    if (!diffNameOnly) {
      // No recent structural activity — only generate if we have nothing stored.
      if (!hasArchitecture) {
        await generateArchitectureOverview(repo, cwd);
      }
      return;
    }

    // Structural changes: new/deleted/renamed files.
    const structuralPatterns = /^[ADR]\t/m;
    const hasStructuralChanges = structuralPatterns.test(diffNameOnly);

    if (!hasStructuralChanges && hasArchitecture) {
      // Content-only changes — architecture hasn't drifted.
      return;
    }

    // ── 3. Analyze and update architecture ──
    await generateArchitectureOverview(repo, cwd);
  } catch (err) {
    logger.warn("refreshArchitectureOverviewOnDefault: architecture check failed", {
      repoId: repo.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Architecture Context Builder ───────────────────────────────────────────

/**
 * Builds a context string from the project + repo architecture fields.
 * Injected as system prompt context for the CLI executor so it understands
 * the codebase structure before making changes.
 */
export async function buildArchitectureContext(epicId: EpicTaskId): Promise<string> {
  const epic = await EpicTask.findByPk(epicId, {
    include: [
      { model: Project, as: "project" },
      { model: Repository, as: "repositories" },
    ],
  });
  if (!epic) return "";

  const project = (epic as any).project as Project | null;
  const repos = ((epic as any).repositories ?? []) as Repository[];

  const sections: string[] = [];

  sections.push("# Project & Repository Context");
  sections.push(
    "You are working on LOCAL repository clones on this machine. " +
    "All file operations, git commands, and builds happen locally. " +
    "Do NOT attempt to use GitHub APIs, MCP servers, or any remote repository access."
  );

  if (project) {
    sections.push(`\n## Project: ${project.name}`);
    if (project.description) sections.push(project.description);
    if (project.techStack) sections.push(`\n### Tech Stack\n${project.techStack}`);
    if (project.architectureOverview) {
      sections.push(`\n### Project Architecture\n${project.architectureOverview}`);
    }
  }

  for (const repo of repos) {
    sections.push(`\n## Repository: ${repo.name}`);
    if (repo.url) sections.push(`Remote: ${repo.url}`);
    if (repo.localPath) sections.push(`Local path: ${repo.localPath}`);
    if (repo.defaultBranch) sections.push(`Default branch: ${repo.defaultBranch}`);
    if (repo.architectureOverview) {
      sections.push(`\n### Architecture\n${repo.architectureOverview}`);
    }
    if (repo.setupInstructions) {
      sections.push(`\n### Setup & Build\n${repo.setupInstructions}`);
    }
  }

  sections.push(
    "\n## Git Commit Requirement (MANDATORY)\n" +
    "The repository has already been checked out on the correct stage feature branch for you — " +
    "do NOT run `git checkout`, `git switch`, `git branch`, or `git pull` yourself, and do NOT " +
    "push or open a PR (the system handles push + PR creation after you exit).\n\n" +
    "Before you finish the task you MUST stage and commit every change you made:\n" +
    "  1. Run `git add -A`\n" +
    "  2. Run `git commit -m \"<short English message describing what this task changed>\"`\n\n" +
    "Rules for the commit:\n" +
    "- The commit message MUST be in English, regardless of the language the user is speaking.\n" +
    "- Leave zero uncommitted changes in the working tree when you exit — every file you " +
    "created, modified, or deleted must be in the commit.\n" +
    "- If you made no file changes, do NOT create an empty commit; just exit cleanly.\n" +
    "- Never use `--amend`, `--no-verify`, `git reset --hard`, force push, or any destructive " +
    "git operation unless the task description explicitly says so."
  );

  return sections.join("\n");
}

// ─── Task Execution via Claude CLI ───────────────────────────────────────────

export async function executeTask(
  taskId: AgentTaskId,
  options: {
    cwd: string;
    allowedTools?: string;
    maxTurns?: number;
    systemPrompt?: string;
    promptOverride?: string;
    resumeSessionId?: string;
    /** CLI agent name to pass via --agent-name (e.g. "Dag"). */
    agentName?: string;
    /**
     * Replacement prompt to use if --resume fails and we fall back to a
     * fresh Claude CLI session. The `promptOverride` is typically written
     * as a continuation ("you previously changed..."), which is incoherent
     * for a new session that has no memory of the prior attempt. Callers
     * that use `resumeSessionId` should provide a standalone version of
     * the prompt here so the fallback session gets coherent instructions.
     *
     * Ignored if `resumeSessionId` is not set.
     */
    freshPromptFallback?: string;
    /**
     * Absolute path the CLI was instructed to write its per-task summary
     * `.md` file to (via the system prompt's "Required output: per-task
     * summary file" block). Set by the caller using `buildTaskSummaryFilePath`
     * with the *current* threadId — same value the system prompt names — so
     * the post-success persist on `agent_tasks.summary_file_path` matches
     * what the CLI actually wrote. Null/omitted disables the persist
     * (e.g. non-chat invocations without a thread context).
     */
    expectedSummaryFilePath?: string | null;
  },
): Promise<TaskExecution> {
  const task = await AgentTask.findByPk(taskId, {
    include: [{ model: TaskStage, as: "stage" }],
  });
  if (!task) throw new Error(`Agent task ${taskId} not found`);

  // Update task status to in_progress
  await task.update({
    status: "in_progress" as AgentTaskStatus,
    startedAt: task.startedAt ?? new Date(),
    completedAt: null,
  });

  // Build the prompt first so it's persisted even if the CLI spawn fails
  const prompt = options.promptOverride ?? task.description ?? task.title;

  // Create execution record (stores the exact prompt sent to the CLI)
  const execution = await startExecution(taskId, { prompt });

  const args = [
    "-p",
    prompt,
    "--dangerously-skip-permissions",
    "--output-format",
    "json",
  ];

  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }

  // Default to effectively unlimited turns — the CLI's built-in default (~21) is too low for complex tasks
  args.push("--max-turns", String(options.maxTurns ?? 200));

  if (options.systemPrompt) {
    args.push("--append-system-prompt", options.systemPrompt);
  }

  if (options.agentName) {
    args.push("--agent-name", options.agentName);
  }

  logger.info("Executing agent task via Claude CLI", {
    taskId,
    executionId: execution.id,
    cwd: options.cwd,
    agentName: options.agentName ?? null,
  });

  // Snapshot HEAD before running the CLI so captureGitDiff can diff against
  // it afterwards. This is what makes git_diff / git_diff_stat actually
  // reflect the task's work even when the CLI (or our safety-net
  // ensureWorkingTreeCommitted) commits everything before we get to inspect
  // the working tree. Running as `agent` via gitAsAgent matches the user
  // that owns the repo files.
  let preRunSha: string | null = null;
  try {
    preRunSha = gitAsAgent(options.cwd, ["rev-parse", "HEAD"]) || null;
  } catch (snapshotErr: any) {
    logger.warn("executeTask: failed to snapshot HEAD before CLI run", {
      taskId,
      cwd: options.cwd,
      error: snapshotErr?.message,
    });
  }

  return new Promise<TaskExecution>((resolve, reject) => {
    const child = spawn("su-exec", ["agent", "claude", ...args], {
      cwd: options.cwd,
      env: agentSpawnEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", async (code) => {
      try {
        if (code === 0) {
          let resultText: string;
          let sessionId: string | null = null;
          let metadata: Record<string, unknown> = {};

          try {
            const parsed = JSON.parse(stdout);
            resultText = parsed.result ?? stdout;
            sessionId = parsed.session_id ?? null;
            metadata = {
              session_id: parsed.session_id,
              cost_usd: parsed.cost_usd,
              duration_ms: parsed.duration_ms,
              num_turns: parsed.num_turns,
              is_error: parsed.is_error,
            };
          } catch {
            resultText = stdout;
          }

          // Safety-net: if the CLI left uncommitted changes behind, stage and
          // commit them ourselves so the stage's PR push has something to ship.
          // The architecture context already instructs the executor to commit,
          // but we can't rely on that alone — a stray `git add -A && git commit`
          // here is cheap insurance against an empty-diff PR.
          try {
            const autoCommitResult = ensureWorkingTreeCommitted(
              options.cwd,
              task.title,
            );
            if (autoCommitResult.committed) {
              metadata.auto_committed = true;
              metadata.auto_commit_message = autoCommitResult.message;
              logger.info("executeTask: auto-committed leftover changes", {
                taskId,
                cwd: options.cwd,
                message: autoCommitResult.message,
              });
            }
          } catch (commitErr: any) {
            logger.warn("executeTask: safety-net auto-commit failed", {
              taskId,
              cwd: options.cwd,
              error: commitErr?.message,
            });
          }

          // Capture git diff after successful execution — diffs against the
          // pre-run HEAD snapshot so commits made during this task still show
          // up in git_diff / git_diff_stat.
          try {
            const gitDiff = captureGitDiff(options.cwd, preRunSha);
            metadata.git_diff_stat = gitDiff.diffStat;
            metadata.git_diff = gitDiff.fullDiff;
            metadata.git_recent_commits = gitDiff.recentCommits;
            if (preRunSha) metadata.git_diff_base_sha = preRunSha;
          } catch (diffErr: any) {
            logger.warn("Failed to capture git diff after task execution", {
              taskId,
              error: diffErr.message,
            });
          }

          await completeExecution(execution.id, {
            result: resultText,
            metadata,
          });

          if (sessionId) {
            await execution.update({ cliSessionId: sessionId });
          }

          // Persist the per-task summary file path so retrieval tools
          // (`get_epic_task_stages_and_tasks`) can fan out the latest summary via
          // `send_file_to_user`. Idempotent — overwrites the prior value on
          // every retry, which is exactly what the user wants ("most updated
          // and relevant file"). No-op when caller didn't pass a path or
          // when the CLI ignored the instruction (file missing on disk).
          if (options.expectedSummaryFilePath) {
            await recordTaskSummaryFilePath(taskId, options.expectedSummaryFilePath);
          }

          await updateTaskStatus(taskId, "completed");

          const updated = await TaskExecution.findByPk(execution.id);
          resolve(updated!);
        } else {
          logger.warn("Claude CLI exited with non-zero code", {
            taskId,
            executionId: execution.id,
            code,
            stderrPreview: stderr.slice(0, 1000),
            stdoutPreview: stdout.slice(0, 1000),
          });

          // "Reached max turns" or similar — CLI may still have produced useful output
          if (stdout.trim()) {
            let resultText: string;
            let sessionId: string | null = null;
            let metadata: Record<string, unknown> = { exitCode: code, warning: stderr || `exit code ${code}` };

            try {
              const parsed = JSON.parse(stdout);
              resultText = parsed.result ?? stdout;
              sessionId = parsed.session_id ?? null;
              metadata = {
                ...metadata,
                session_id: parsed.session_id,
                cost_usd: parsed.cost_usd,
                duration_ms: parsed.duration_ms,
                num_turns: parsed.num_turns,
                is_error: parsed.is_error,
              };
            } catch {
              resultText = stdout;
            }

            try {
              const gitDiff = captureGitDiff(options.cwd, preRunSha);
              metadata.git_diff_stat = gitDiff.diffStat;
              metadata.git_diff = gitDiff.fullDiff;
              if (preRunSha) metadata.git_diff_base_sha = preRunSha;
              metadata.git_recent_commits = gitDiff.recentCommits;
            } catch (diffErr: any) {
              logger.warn("Failed to capture git diff after task execution", { taskId, error: diffErr.message });
            }

            await completeExecution(execution.id, { result: resultText, metadata });
            if (sessionId) await execution.update({ cliSessionId: sessionId });
            await updateTaskStatus(taskId, "completed");

            const updated = await TaskExecution.findByPk(execution.id);
            resolve(updated!);
          } else {
            const errorMsg = stderr || `Claude CLI exited with code ${code}`;

            // If --resume failed because the session no longer exists, retry without it.
            // Swap in the caller-provided fresh-session prompt so the new (memoryless)
            // session doesn't receive a continuation-style prompt that references
            // "what you previously changed".
            if (
              options.resumeSessionId &&
              (errorMsg.includes("No conversation found") || stdout.includes("No conversation found"))
            ) {
              logger.warn("Session not found — retrying without --resume", {
                taskId,
                sessionId: options.resumeSessionId,
                usingFreshPrompt: !!options.freshPromptFallback,
              });
              // Clean up the failed execution before retrying
              await failExecution(execution.id, { error: "Session expired — retrying fresh" });

              try {
                const retryResult = await executeTask(taskId, {
                  ...options,
                  resumeSessionId: undefined,
                  promptOverride: options.freshPromptFallback ?? options.promptOverride,
                  freshPromptFallback: undefined,
                });
                resolve(retryResult);
              } catch (retryErr) {
                reject(retryErr);
              }
              return;
            }

            await failExecution(execution.id, { error: errorMsg });
            await updateTaskStatus(taskId, "failed");

            const updated = await TaskExecution.findByPk(execution.id);
            resolve(updated!);
          }
        }
      } catch (err) {
        reject(err);
      }
    });

    child.on("error", async (err) => {
      logger.error("Claude CLI spawn error", { taskId, error: err.message });
      await failExecution(execution.id, { error: err.message });
      await updateTaskStatus(taskId, "failed");
      reject(err);
    });
  });
}

// ─── Bulk Epic Creation ──────────────────────────────────────────────────────

export async function createEpicWithPlan(data: {
  title: string;
  description: string;
  projectId: ProjectId;
  userId: UserId;
  agentId: AgentId;
  repositoryIds?: RepositoryId[];
  stages: Array<{
    title: string;
    description?: string;
    kind?: TaskStageKind;
    tasks: Array<{
      title: string;
      description?: string;
    }>;
  }>;
}): Promise<EpicTask> {
  const transaction = await sequelize.transaction();
  try {
    const epic = await EpicTask.create(
      {
        title: data.title,
        description: data.description,
        projectId: data.projectId,
        userId: data.userId,
        agentId: data.agentId,
      },
      { transaction },
    );

    if (data.repositoryIds?.length) {
      await EpicTaskRepository.bulkCreate(
        data.repositoryIds.map((repositoryId) => ({
          epicTaskId: epic.id,
          repositoryId,
        })),
        { transaction },
      );
    }

    const allTasks: AgentTask[] = [];

    for (let si = 0; si < data.stages.length; si++) {
      const stageData = data.stages[si];
      const stage = await TaskStage.create(
        {
          epicTaskId: epic.id,
          title: stageData.title,
          description: stageData.description,
          kind: stageData.kind ?? ("code_change" as TaskStageKind),
          sortOrder: si,
        },
        { transaction },
      );

      for (let ti = 0; ti < stageData.tasks.length; ti++) {
        const taskData = stageData.tasks[ti];
        const task = await AgentTask.create(
          {
            taskStageId: stage.id,
            title: taskData.title,
            description: taskData.description,
            sortOrder: ti,
          },
          { transaction },
        );
        allTasks.push(task);
      }
    }

    await transaction.commit();

    // Refresh architecture overviews from each repo's DEFAULT branch. This
    // runs once per epic (here, at plan-creation time) rather than per task,
    // so the stored overview always reflects the repo's merged/canonical
    // state — never a speculative stage branch that may be abandoned. By the
    // time the first task runs, `buildArchitectureContext` will pick up the
    // fresh overview and inject it into the executor's system prompt.
    //
    // Non-fatal: failures are logged inside the helper and must not block
    // epic creation.
    if (data.repositoryIds?.length) {
      const planRepos = await Repository.findAll({
        where: { id: data.repositoryIds as unknown as string[] },
      });
      for (const repo of planRepos) {
        await refreshArchitectureOverviewOnDefault(repo);
      }
    }

    // Mark all tasks in stage 1 (first stage) as 'ready'
    const firstStageId = allTasks.length > 0
      ? (await TaskStage.findOne({
          where: { epicTaskId: epic.id },
          order: [["sort_order", "ASC"]],
          attributes: ["id"],
        }))?.id
      : null;

    if (firstStageId) {
      await AgentTask.update(
        { status: "ready" as AgentTaskStatus },
        { where: { taskStageId: firstStageId } },
      );
    }

    return getEpic(epic.id, { includeStages: true, includeTasks: true }) as Promise<EpicTask>;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

// ─── Continue Remaining Stage Tasks ─────────────────────────────────────────

/**
 * After a single task or retry completes, run any remaining pending/ready
 * tasks in the same stage sequentially by sort_order.
 */
export async function continueRemainingTasks(
  completedTaskId: string,
  options: {
    cwd: string;
    allowedTools?: string;
    maxTurns?: number;
    systemPrompt?: string;
    agentName?: string;
    /**
     * When set, every sub-task execution gets its per-task summary path
     * computed and persisted on success — same flow as the first task in
     * `ExecuteEpicTaskTool`. Optional so non-chat callers (none today) keep
     * working without a thread context.
     */
    summaryContext?: { agentId: AgentId; threadId: string };
  },
): Promise<string | null> {
  const task = await AgentTask.findByPk(completedTaskId, {
    include: [{ model: TaskStage, as: "stage" }],
  });
  if (!task) return null;

  const stageId = task.taskStageId;
  const remaining = await AgentTask.findAll({
    where: { taskStageId: stageId, status: ["pending", "ready"] },
    order: [["sort_order", "ASC"]],
  });

  if (remaining.length === 0) return null;

  const results: string[] = [];
  for (const next of remaining) {
    logger.info("continueRemainingTasks: executing", {
      taskId: next.id,
      taskTitle: next.title,
    });

    const expectedSummaryFilePath = options.summaryContext
      ? await buildTaskSummaryFilePath({
          agentId: options.summaryContext.agentId,
          threadId: options.summaryContext.threadId,
          taskId: next.id,
        })
      : null;

    const execution = await executeTask(next.id, {
      cwd: options.cwd,
      allowedTools: options.allowedTools,
      maxTurns: options.maxTurns,
      systemPrompt: options.systemPrompt,
      agentName: options.agentName,
      expectedSummaryFilePath,
    });

    results.push(await formatExecutionResult(execution, next.id));

    if (execution.status === "failed") {
      results.push(`\n⚠ Task "${next.title}" failed. Stopping sequential execution.`);
      break;
    }
  }

  return results.join("\n\n---\n\n");
}

// ─── Automatic PR Creation ──────────────────────────────────────────────────

export interface AutoPrResult {
  ok: boolean;
  prUrl?: string;
  prNumber?: number;
  error?: string;
}

/**
 * Deterministically creates a PR for a completed stage. No LLM involved.
 * 1. git push origin HEAD
 * 2. gh pr create
 * 3. Update the stage DB record with the PR info
 */
export async function autoCreateStagePr(
  stage: TaskStage,
  repo: Repository,
  epicTitle: string,
): Promise<AutoPrResult> {
  const cwd = repo.localPath;
  if (!cwd) return { ok: false, error: "Repository has no localPath" };

  const baseBranch = repo.defaultBranch || "main";

  // ── Pre-flight guard #1: refuse to create a PR when HEAD is still on the
  //    default branch. If this happens it means `preExecutionSync` never
  //    created a stage feature branch (the very bug this whole flow fixes),
  //    so `gh pr create` would fall over with the cryptic
  //    "No commits between <base> and <base>" error. Fail fast with a clear
  //    message instead, and do NOT push anything to origin.
  let currentBranch: string;
  try {
    currentBranch = gitAsAgent(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) || "";
  } catch (err: any) {
    logger.error("autoCreateStagePr: cannot resolve current branch", {
      stageId: stage.id,
      error: err?.message,
    });
    return { ok: false, error: `cannot resolve current branch: ${err?.message}` };
  }

  if (!currentBranch || currentBranch === "HEAD") {
    return {
      ok: false,
      error:
        `cannot create PR: repository is in a detached HEAD state (expected a stage feature branch off '${baseBranch}')`,
    };
  }

  if (currentBranch === baseBranch) {
    logger.error("autoCreateStagePr: HEAD is on base branch — no feature branch was created", {
      stageId: stage.id,
      currentBranch,
      baseBranch,
    });
    return {
      ok: false,
      error:
        `cannot create PR: HEAD is still on the default branch '${baseBranch}'. ` +
        `The stage was supposed to be working on its own feature branch — this usually means ` +
        `preExecutionSync failed to create the stage branch. Check the agent_service logs for ` +
        `'preExecutionSync: failed to create stage branch'.`,
    };
  }

  // ── Pre-flight guard #2: make sure the feature branch actually has commits
  //    the base branch does not. If the executor edited files but never
  //    committed them, `git rev-list --count <base>..HEAD` returns 0, and
  //    `gh pr create` would error with "No commits between <base> and <head>".
  //    Check against the local base ref, falling back to origin/<base>.
  try {
    // Make sure we have the latest base ref to compare against. Best-effort —
    // failure here just means the comparison below uses whatever's local.
    try {
      gitAsAgent(cwd, ["fetch", "origin", baseBranch]);
    } catch {
      // ignore — network hiccups shouldn't fail the whole PR creation
    }

    const baseRef = (() => {
      try {
        gitAsAgent(cwd, ["rev-parse", "--verify", `origin/${baseBranch}`]);
        return `origin/${baseBranch}`;
      } catch {
        return baseBranch;
      }
    })();

    const aheadCount = gitAsAgent(cwd, ["rev-list", "--count", `${baseRef}..HEAD`]);

    if (aheadCount === "0") {
      logger.error("autoCreateStagePr: no commits ahead of base branch", {
        stageId: stage.id,
        currentBranch,
        baseRef,
      });
      return {
        ok: false,
        error:
          `cannot create PR: '${currentBranch}' has 0 commits ahead of '${baseRef}'. ` +
          `The task executor did not commit any changes. Check whether ensureWorkingTreeCommitted ran, ` +
          `and whether the architecture-context commit instruction is reaching the CLI.`,
      };
    }
  } catch (err: any) {
    // Guard #2 itself failed — log and fall through. We still prefer to try
    // `gh pr create` over hard-stopping the flow on a counting hiccup.
    logger.warn("autoCreateStagePr: ahead-count guard failed (continuing)", {
      stageId: stage.id,
      error: err?.message,
    });
  }

  // 1. Push commits to remote and capture the working branch so retries can
  //    sync against that branch (not the repo default) after `request_stage_changes`.
  let stageBranch: string | null = null;
  try {
    gitAsAgent(cwd, ["push", "-u", "origin", "HEAD"]);
    stageBranch = currentBranch;
    logger.info("autoCreateStagePr: pushed to remote", {
      stageId: stage.id,
      cwd,
      branch: stageBranch,
    });
  } catch (err: any) {
    logger.error("autoCreateStagePr: git push failed", { stageId: stage.id, error: err?.message });
    return { ok: false, error: `git push failed: ${err?.message}` };
  }

  // 2. Build PR title and body from stage/task metadata
  const tasks = await AgentTask.findAll({
    where: { taskStageId: stage.id },
    order: [["sort_order", "ASC"]],
  });

  const prTitle = `${epicTitle} — ${stage.title}`;
  const bodyParts = [
    `## ${stage.title}`,
    "",
    stage.description || "",
    "",
    "### Tasks completed",
    ...tasks.map((t) => `- **${t.title}** (${t.status})`),
  ];

  // Add diff stat if available. Prefer the stage's captured baseline SHA
  // (recorded by preExecutionSync when the branch was first created) so
  // the PR body shows exactly what this stage produced, not what's ahead
  // of wherever `base` happens to be right now — the default branch may
  // have advanced since the stage started.
  try {
    const anchor = stage.baseCommitSha || `${baseBranch}...HEAD`;
    const diffArgs = stage.baseCommitSha
      ? ["diff", "--stat", stage.baseCommitSha]
      : ["diff", "--stat", `${baseBranch}...HEAD`];
    const diffStat = gitAsAgent(cwd, diffArgs);
    if (diffStat) {
      bodyParts.push("", "### Changes", "```", diffStat, "```");
      if (stage.baseCommitSha) {
        bodyParts.push("", `_Diff anchored at \`${anchor.slice(0, 12)}\` — the commit this stage branched from._`);
      }
    }
  } catch {
    // Non-fatal — diff stat is nice-to-have
  }

  const prBody = bodyParts.join("\n");

  // 3. Create the PR via gh CLI
  try {
    const ghResult = spawnSync(
      "su-exec",
      ["agent", "gh", "pr", "create",
        "--title", prTitle,
        "--body", prBody,
        "--base", baseBranch,
        "--head", currentBranch,
      ],
      { cwd, env: agentSpawnEnv(), encoding: "utf-8", timeout: 60_000 },
    );

    if (ghResult.error) {
      throw ghResult.error;
    }

    const ghOutput = (ghResult.stdout ?? "").trim();
    const ghStderr = (ghResult.stderr ?? "").trim();

    if (ghResult.status !== 0) {
      throw new Error(ghStderr || `gh exited with code ${ghResult.status}`);
    }

    // gh pr create outputs the PR URL on stdout
    const prUrl = ghOutput;
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : null;

    if (!prNumber) {
      logger.warn("autoCreateStagePr: could not parse PR number from gh output", { ghOutput });
      return { ok: false, error: `Created PR but could not parse number from: ${ghOutput}` };
    }

    // 4. Update the stage record. Only persist `branchName` if it's an
    //    actual feature branch — never store the repo's default branch.
    const persistedBranch =
      stageBranch && stageBranch !== baseBranch && stageBranch !== "HEAD"
        ? stageBranch
        : null;

    await stage.update({
      prUrl,
      prNumber,
      prStatus: "open" as PrStatus,
      repositoryId: repo.id,
      branchName: persistedBranch,
    });

    logger.info("autoCreateStagePr: PR created and stage updated", {
      stageId: stage.id,
      prUrl,
      prNumber,
    });

    return { ok: true, prUrl, prNumber };
  } catch (err: any) {
    logger.error("autoCreateStagePr: gh pr create failed", { stageId: stage.id, error: err?.message });
    return { ok: false, error: `gh pr create failed: ${err?.message}` };
  }
}

/**
 * Pushes fixes to an existing PR after a retry.
 */
export async function autoPushToExistingPr(
  stage: TaskStage,
  repo: Repository,
): Promise<AutoPrResult> {
  const cwd = repo.localPath;
  if (!cwd) return { ok: false, error: "Repository has no localPath" };

  try {
    gitAsAgent(cwd, ["push", "origin", "HEAD"]);

    // Update PR status back to "open" — fixes pushed, awaiting re-review
    await stage.update({ prStatus: "open" as PrStatus });

    logger.info("autoPushToExistingPr: pushed fixes", {
      stageId: stage.id,
      prNumber: stage.prNumber,
    });

    return { ok: true, prUrl: stage.prUrl ?? undefined, prNumber: stage.prNumber ?? undefined };
  } catch (err: any) {
    logger.error("autoPushToExistingPr: git push failed", { stageId: stage.id, error: err?.message });
    return { ok: false, error: `git push failed: ${err?.message}` };
  }
}

// ─── Continuation Marker ────────────────────────────────────────────────────

/** Marker prefix used to signal that the worker should auto-continue the epic. */
export const EPIC_CONTINUATION_MARKER = "<!--EPIC_CONTINUATION:";

interface EpicContinuationPayload {
  epicId: string;
  completedTaskTitle: string;
  remainingTasks: number;
}

function buildContinuationTag(payload: EpicContinuationPayload): string {
  return `\n${EPIC_CONTINUATION_MARKER}${JSON.stringify(payload)}-->`;
}

/**
 * Given a taskId, resolves its epic and checks if more tasks remain.
 * Returns the continuation tag string (or empty string if no continuation needed).
 */
export async function appendContinuationMarker(taskId: string): Promise<string> {
  try {
    const task = await AgentTask.findByPk(taskId, {
      include: [{ model: TaskStage, as: "stage" }],
    });
    if (!task) return "";

    const stage = (task as any).stage as TaskStage | undefined;
    if (!stage?.epicTaskId) return "";

    const readyTasks = await getReadyTasks(stage.epicTaskId);

    if (readyTasks.length > 0) {
      return buildContinuationTag({
        epicId: stage.epicTaskId,
        completedTaskTitle: task.title,
        remainingTasks: readyTasks.length,
      });
    }

    // No more ready tasks — check if this stage just finished all tasks and needs PR action
    const freshStage = await TaskStage.findByPk(stage.id);
    if (freshStage && (freshStage.status === "pr_pending" || freshStage.status === "completed")) {
      // Plan stages have no commits and no PR — review happens against the
      // produced plan/spec text in the chat. Tell the orchestrator the stage
      // is awaiting the user's explicit approval (the same `approve_stage`
      // tool that handles code_change stages routes through the no-PR
      // branch when there's no prNumber).
      if (freshStage.kind === ("plan" as TaskStageKind)) {
        const pos = await resolveStagePosition(freshStage);
        const positionLabel = pos ? ` (stage ${pos.index} of ${pos.total})` : "";
        const nextLine = pos?.isLast
          ? `**This is the FINAL stage of the epic.** Approving it completes the epic — there is no stage ${pos!.total + 1}; no further stages will run after approval.`
          : pos
            ? `Approving this stage will unblock stage ${pos.index + 1} of ${pos.total} and its tasks will start automatically.`
            : `Approving this stage will unblock the next stage's tasks (if any) automatically.`;
        return (
          `\n\n## Plan Stage Awaiting Review${positionLabel}\n\n` +
          `Stage "${freshStage.title}" is a planning-only stage — no code changes, no PR.\n` +
          `All its tasks are complete. **No further stage will start until the user explicitly ` +
          `approves this plan.**\n\n` +
          `${nextLine}\n\n` +
          `Summarize the plan for the user and wait for their approval. Once they ` +
          `confirm, call \`approve_stage\` with their verbatim authorization quote. ` +
          `**Phrase your prompt to the user honestly — do NOT invent a next-stage number ` +
          `that doesn't exist.**`
        );
      }

      const epic = await EpicTask.findByPk(stage.epicTaskId, {
        include: [{ model: Repository, as: "repositories" }],
      });
      const repos = ((epic as any)?.repositories ?? []) as Repository[];
      const repo = repos[0];

      if (!repo) {
        return "\n\n⚠ Stage completed but no repository found — cannot create PR automatically.";
      }

      // Case 1: Stage completed after retry (PR has changes_requested) — push fixes
      if (freshStage.prNumber && freshStage.prStatus === "changes_requested") {
        const pushResult = await autoPushToExistingPr(freshStage, repo);
        if (pushResult.ok) {
          const pos = await resolveStagePosition(freshStage);
          const positionLabel = pos ? ` (stage ${pos.index} of ${pos.total})` : "";
          const blockerLine = pos?.isLast
            ? `**This is the FINAL stage of the epic.** Approving the PR completes the epic — there is no stage ${pos!.total + 1}.`
            : pos
              ? `Stage ${pos.index + 1} of ${pos.total} is blocked until this PR is approved.`
              : `The next stage (if any) is blocked until this PR is approved.`;
          return (
            `\n\n## Fixes Pushed to PR #${freshStage.prNumber}${positionLabel}\n\n` +
            `All retry tasks completed and fixes have been pushed automatically.\n` +
            `PR: ${freshStage.prUrl ?? `#${freshStage.prNumber}`}\n` +
            `${blockerLine}`
          );
        }
        return (
          `\n\n## ⚠ Auto-push Failed\n\n` +
          `Error: ${pushResult.error}\n` +
          `You need to manually push the fixes: \`git push origin HEAD\` from ${repo.localPath}`
        );
      }

      // Case 2: Stage completed for the first time — create a new PR
      if (!freshStage.prNumber) {
        const prResult = await autoCreateStagePr(freshStage, repo, epic?.title ?? "Epic");
        if (prResult.ok) {
          const pos = await resolveStagePosition(freshStage);
          const positionLabel = pos ? ` (stage ${pos.index} of ${pos.total})` : "";
          const nextLine = pos?.isLast
            ? `**This is the FINAL stage of the epic.** Approving this PR completes the epic — there is no stage ${pos!.total + 1}; no further stages will run.`
            : pos
              ? `Stage ${pos.index + 1} of ${pos.total} will begin automatically once this PR is approved.`
              : `The next stage will begin automatically once the PR is approved.`;
          return (
            `\n\n## Pull Request Created Automatically${positionLabel}\n\n` +
            `**PR #${prResult.prNumber}:** ${prResult.prUrl}\n` +
            `Stage "${freshStage.title}" is now waiting for PR approval.\n` +
            `${nextLine}\n\n` +
            `**When you tell the user about the PR, phrase the next-step honestly — do NOT ` +
            `invent a next-stage number that doesn't exist.**`
          );
        }
        return (
          `\n\n## ⚠ Auto PR Creation Failed\n\n` +
          `Error: ${prResult.error}\n` +
          `You need to manually create the PR:\n` +
          `1. \`cd ${repo.localPath} && git push origin HEAD\`\n` +
          `2. \`gh pr create --title "Stage: ${freshStage.title}" --base ${repo.defaultBranch ?? "main"}\`\n` +
          `3. Then call \`update_stage_pr\` with the PR details.`
        );
      }
    }

    return "";
  } catch {
    return "";
  }
}

/**
 * Parses the continuation marker from a tool result string.
 * Returns the payload if found, null otherwise.
 */
export function parseContinuationMarker(text: string): EpicContinuationPayload | null {
  const idx = text.indexOf(EPIC_CONTINUATION_MARKER);
  if (idx === -1) return null;

  const start = idx + EPIC_CONTINUATION_MARKER.length;
  const end = text.indexOf("-->", start);
  if (end === -1) return null;

  try {
    return JSON.parse(text.slice(start, end));
  } catch {
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RETRY_EPIC_TASK_HINT =
  `If fixes are needed, call \`execute_epic_task\` with \`mode='retry'\` and provide **specific feedback** referencing the diff lines that need to change.`;

/**
 * Footer for completed task reports: only tell the orchestrator to "proceed to the next task"
 * when {@link getReadyTasks} is non-empty. When a stage just finished, the stage moves to
 * `pr_pending` and there are no ready tasks — the next stage must not run until PR approval.
 */
async function formatReviewActionForCompletedTask(taskId: string): Promise<string> {
  const task = await AgentTask.findByPk(taskId, {
    include: [{ model: TaskStage, as: "stage" }],
  });
  const stage = (task as { stage?: TaskStage } | null)?.stage;
  const epicId = stage?.epicTaskId;
  if (!epicId) {
    return `\n**Action:** If the changes are correct, proceed when appropriate. ${RETRY_EPIC_TASK_HINT}`;
  }

  const readyTasks = await getReadyTasks(epicId);
  if (readyTasks.length > 0) {
    return (
      `\n**Action:** If the changes are correct, proceed to the next task. ${RETRY_EPIC_TASK_HINT}`
    );
  }

  const stageRow = await TaskStage.findByPk(stage.id);
  if (stageRow?.status === ("pr_pending" as TaskStageStatus)) {
    const pos = await resolveStagePosition(stageRow);
    const positionLabel = pos ? ` (stage ${pos.index} of ${pos.total})` : "";
    const finalityLine = pos?.isLast
      ? ` **This is the FINAL stage of the epic — approving it completes the whole epic; do NOT tell the user a next-stage number.**`
      : pos
        ? ` Approval will start stage ${pos.index + 1} of ${pos.total}.`
        : "";
    if (stageRow.kind === ("plan" as TaskStageKind)) {
      return (
        `\n**Action:** **This plan stage is complete${positionLabel}** and is **waiting for the user to review and approve** — ` +
        `do **not** call \`execute_epic_task\` to start the next stage until they confirm.${finalityLine} ` +
        `Summarize the plan, ask for approval, then call \`approve_stage\` with their verbatim quote. ${RETRY_EPIC_TASK_HINT}`
      );
    }
    return (
      `\n**Action:** **This stage is complete${positionLabel}** and is **waiting for PR approval** — do **not** call ` +
      `\`execute_epic_task\` to start the next stage until this PR is approved (or handled via \`approve_stage\` / your workflow).${finalityLine} ` +
      `Tell the user the stage is blocked on review. ${RETRY_EPIC_TASK_HINT}`
    );
  }

  const epic = await EpicTask.findByPk(epicId);
  if (epic?.status === ("completed" as EpicTaskStatus)) {
    return `\n**Action:** This epic is finished — there are no more tasks.`;
  }

  return (
    `\n**Action:** No task is currently in the ready queue. Use \`get_epic_status\` to see the epic state (e.g. waiting on PR approval). ${RETRY_EPIC_TASK_HINT}`
  );
}

/**
 * Deterministic absolute path the CLI is told to write its per-task summary
 * `.md` file to. Path is `<agent.workspacePath>/threads/<threadId>/task-<8charId>-summary.md`
 * — keyed on the *current* threadId, not whatever thread the task was
 * planned in, so a cross-thread retry lands in the active thread's folder.
 *
 * No attempt number in the filename — by design. Each retry overwrites the
 * previous summary, and `agent_tasks.summary_file_path` always points at the
 * latest, surfacing the most relevant content to "show me what we did" type
 * queries (the user's stated requirement). This also avoids an ordering
 * hazard: `buildSystemPrompt` runs before `startExecution` allocates an
 * attempt number, so encoding the attempt in the path would force a
 * pre-flight query just to keep it in sync.
 *
 * Returns null when we can't compute it (missing workspace, missing thread,
 * agent lookup failed). Callers must handle null gracefully — either skip
 * the summary instruction (CLI prompt) or skip the persist (executeTask).
 */
export async function buildTaskSummaryFilePath(args: {
  agentId: AgentId;
  threadId: string | null | undefined;
  taskId: AgentTaskId;
}): Promise<string | null> {
  if (!args.threadId) return null;
  try {
    const agent = await Agent.findByPk(args.agentId, { attributes: ["workspacePath"] });
    const workspacePath =
      (agent as { workspacePath?: string | null } | null)?.workspacePath ?? null;
    if (!workspacePath) return null;
    const shortTaskId = String(args.taskId).slice(0, 8);
    return `${workspacePath}/threads/${args.threadId}/task-${shortTaskId}-summary.md`;
  } catch {
    return null;
  }
}

/**
 * Post-execution: if the CLI was supposed to write the summary file at
 * `expectedPath`, verify the file exists on disk and persist that path on
 * the agent_tasks row. Overwrites any prior value — by design, since each
 * retry produces a fresh summary and the previous attempt's file may be in
 * a different (rejected) thread folder we don't want to surface to users.
 *
 * Best-effort: a missing file (CLI ignored the instruction) or a DB hiccup
 * is logged but never throws. Returns the path we persisted, or null if
 * nothing was persisted.
 */
export async function recordTaskSummaryFilePath(
  taskId: AgentTaskId,
  expectedPath: string | null,
): Promise<string | null> {
  if (!expectedPath) return null;
  try {
    if (!fs.existsSync(expectedPath)) {
      logger.warn(
        "recordTaskSummaryFilePath: expected summary file missing — CLI may have skipped the write",
        { taskId, expectedPath },
      );
      return null;
    }
    await AgentTask.update(
      { summaryFilePath: expectedPath },
      { where: { id: taskId } },
    );
    logger.info("recordTaskSummaryFilePath: persisted summary file path", {
      taskId,
      summaryFilePath: expectedPath,
    });
    return expectedPath;
  } catch (err: any) {
    logger.warn("recordTaskSummaryFilePath: persist failed (non-fatal)", {
      taskId,
      expectedPath,
      error: err?.message,
    });
    return null;
  }
}

export async function formatExecutionResult(execution: any, taskId: string): Promise<string> {
  const status = execution.status;
  const meta = execution.metadata ?? {};

  // Fetch task context for the review
  const task = await AgentTask.findByPk(taskId);
  const taskTitle = task?.title ?? "(unknown)";
  const taskDescription = task?.description ?? "(no description)";

  let result = `# Task Execution Report\n\n`;
  result += `**Task:** ${taskTitle}\n`;
  result += `**Task ID:** ${taskId}\n`;
  result += `**Status:** ${status}\n`;
  result += `**Execution ID:** ${execution.id}\n`;
  result += `**Attempt:** #${execution.attemptNumber}\n`;

  if (execution.cliSessionId) {
    result += `**CLI Session:** ${execution.cliSessionId}\n`;
  }
  if (meta.cost_usd) result += `**Cost:** $${meta.cost_usd}\n`;
  if (meta.num_turns) result += `**Turns:** ${meta.num_turns}\n`;

  if (status === "completed") {
    // Section 1: Instructions that were given
    result += `\n## Instructions Given\n`;
    result += `${taskDescription}\n`;

    // Section 2: Files changed (git diff --stat)
    if (meta.git_diff_stat) {
      result += `\n## Files Changed\n`;
      result += `\`\`\`\n${meta.git_diff_stat}\n\`\`\`\n`;
    }

    // Section 3: Full diff
    if (meta.git_diff) {
      result += `\n## Full Diff\n`;
      result += `\`\`\`diff\n${meta.git_diff}\n\`\`\`\n`;
    } else {
      result += `\n## Full Diff\n`;
      result += `_No git diff captured. The CLI may have committed changes or no files were modified._\n`;
    }

    // Section 4: CLI output summary
    if (execution.result) {
      result += `\n## CLI Output Summary\n`;
      result += `${execution.result}\n`;
    }

    // Section 5: Recent commits
    if (meta.git_recent_commits) {
      result += `\n## Recent Commits\n`;
      result += `\`\`\`\n${meta.git_recent_commits}\n\`\`\`\n`;
    }

    // Section 6: Review checklist
    result += `\n## Review Checklist\n`;
    result += `Before proceeding, verify:\n`;
    result += `- [ ] The changed files match what was requested in the instructions\n`;
    result += `- [ ] There are no unexpected file changes outside the task scope\n`;
    result += `- [ ] The diff implements the logic described in the task description\n`;
    result += `- [ ] No obvious issues: hardcoded values, removed important code, missing imports\n`;
    result += `- [ ] Naming conventions and code style are consistent with the codebase\n`;

    result += await formatReviewActionForCompletedTask(taskId);
  } else if (status === "failed") {
    result += `\n## Error\n`;
    result += `\`\`\`\n${execution.error ?? "Unknown error"}\n\`\`\`\n`;
    result += `\nThe task failed. You can retry with \`mode='retry'\` and feedback, or investigate the error.`;
  }

  return result;
}
