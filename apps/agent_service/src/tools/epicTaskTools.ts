import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { spawn, execSync, spawnSync } from "child_process";
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
  AgentTaskStatus,
  TaskExecutionStatus,
  PrStatus,
} from "@scheduling-agent/types";
import { logger } from "../logger";

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

async function startExecution(
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

async function completeExecution(
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

async function failExecution(
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

async function prepareRetry(
  taskId: AgentTaskId,
  feedback: string,
): Promise<{ previousSessionId: string | null; enrichedFeedback: string }> {
  const lastExec = await TaskExecution.findOne({
    where: { agentTaskId: taskId },
    order: [["attempt_number", "DESC"]],
  });
  const previousSessionId = lastExec?.cliSessionId ?? null;

  if (lastExec) {
    await lastExec.update({ feedback });
  }

  // Enrich feedback with diff context from the previous execution
  let enrichedFeedback = feedback;
  if (lastExec?.metadata) {
    const meta = lastExec.metadata as Record<string, unknown>;
    const diffStat = meta.git_diff_stat as string | undefined;
    const fullDiff = meta.git_diff as string | undefined;

    if (diffStat || fullDiff) {
      enrichedFeedback = `## Feedback from Orchestrator\n\n${feedback}\n`;

      if (diffStat) {
        enrichedFeedback += `\n## Files You Changed (from previous attempt)\n\`\`\`\n${diffStat}\n\`\`\`\n`;
      }

      if (fullDiff) {
        // Truncate diff for retry prompt to keep it focused
        const truncatedDiff = fullDiff.length > 20000
          ? fullDiff.slice(0, 20000) + "\n\n... (diff truncated)"
          : fullDiff;
        enrichedFeedback += `\n## Your Previous Diff\n\`\`\`diff\n${truncatedDiff}\n\`\`\`\n`;
      }

      enrichedFeedback += `\nFix the issues described in the feedback above. Reference the diff to understand what you previously changed.`;
    }
  }

  await AgentTask.update(
    { status: "in_progress" as AgentTaskStatus, completedAt: null },
    { where: { id: taskId } },
  );

  return { previousSessionId, enrichedFeedback };
}

// ─── Dependency Resolution ───────────────────────────────────────────────────

export async function getReadyTasks(epicId: EpicTaskId): Promise<AgentTask[]> {
  const results = await sequelize.query<AgentTask>(
    `SELECT at.*
     FROM agent_tasks at
     JOIN task_stages ts ON at.task_stage_id = ts.id
     WHERE ts.epic_task_id = :epicId
       AND at.status = 'ready'
       -- Block if ANY earlier stage is not completed OR its PR is not approved/merged
       AND NOT EXISTS (
         SELECT 1
         FROM task_stages prev_stage
         WHERE prev_stage.epic_task_id = ts.epic_task_id
           AND prev_stage.sort_order < ts.sort_order
           AND (
             prev_stage.status <> 'completed'
             OR COALESCE(prev_stage.pr_status, 'none') NOT IN ('approved', 'merged')
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

// ─── Status Propagation ─────────────────────────────────────────────────────

async function propagateStatus(taskId: AgentTaskId): Promise<void> {
  const task = await AgentTask.findByPk(taskId);
  if (!task) return;

  // Propagate to stage
  const stageTasks = await AgentTask.findAll({
    where: { taskStageId: task.taskStageId },
  });

  const stageStatuses = stageTasks.map((t) => t.status);
  let newStageStatus: TaskStageStatus;

  if (stageStatuses.every((s) => s === "completed")) {
    newStageStatus = "completed";
  } else if (stageStatuses.some((s) => s === "failed")) {
    newStageStatus = "failed";
  } else if (stageStatuses.some((s) => s === "in_progress" || s === "ready")) {
    newStageStatus = "in_progress";
  } else {
    newStageStatus = "pending";
  }

  const stageUpdates: Record<string, unknown> = { status: newStageStatus };
  if (newStageStatus === "completed") {
    stageUpdates.completedAt = new Date();
  }
  await TaskStage.update(stageUpdates, { where: { id: task.taskStageId } });

  // Propagate to epic
  const stage = await TaskStage.findByPk(task.taskStageId);
  if (!stage) return;

  const epicStages = await TaskStage.findAll({
    where: { epicTaskId: stage.epicTaskId },
  });

  // A stage is fully done only when tasks are completed AND its PR is approved/merged (or no PR exists)
  const allStagesFullyDone = epicStages.every(
    (s) =>
      s.status === "completed" &&
      (!s.prNumber || ["approved", "merged"].includes(s.prStatus ?? "")),
  );
  const epicStatuses = epicStages.map((s) => s.status);
  let newEpicStatus: EpicTaskStatus;

  if (allStagesFullyDone) {
    newEpicStatus = "completed";
  } else if (epicStatuses.some((s) => s === "failed")) {
    newEpicStatus = "failed";
  } else if (epicStatuses.some((s) => s === "in_progress")) {
    newEpicStatus = "in_progress";
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

async function updateTaskStatus(taskId: AgentTaskId, status: AgentTaskStatus): Promise<AgentTask> {
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

interface GitDiffResult {
  diffStat: string;
  fullDiff: string;
  recentCommits: string;
}

function captureGitDiff(cwd: string): GitDiffResult {
  const execOpts = { cwd, encoding: "utf-8" as const, maxBuffer: 2 * 1024 * 1024 };

  let diffStat = "";
  let fullDiff = "";
  let recentCommits = "";

  try {
    // Capture staged + unstaged changes stat summary
    diffStat = execSync("git diff --stat HEAD", execOpts).trim();
    // If nothing against HEAD, try working tree changes
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
    const raw = execSync("git diff HEAD", execOpts).trim();
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

// ─── Pre-Execution Sync ─────────────────────────────────────────────────────

/**
 * Runs before each task execution to ensure repos are up-to-date and
 * architecture descriptions still match reality.
 *
 * For each repository in the epic:
 * 1. `git pull origin <branch>` — get latest changes from remote
 * 2. Detect structural changes since the last known state (new/deleted files)
 * 3. If the repo structure diverged from the stored `architectureOverview`,
 *    spawn a quick Claude CLI call to produce an updated overview and persist it.
 */
async function preExecutionSync(epicId: EpicTaskId): Promise<void> {
  const epic = await EpicTask.findByPk(epicId, {
    include: [{ model: Repository, as: "repositories" }],
  });
  if (!epic) return;

  const repos = ((epic as any).repositories ?? []) as Repository[];
  if (repos.length === 0) return;

  for (const repo of repos) {
    if (!repo.localPath) continue;

    const cwd = repo.localPath;
    const branch = repo.defaultBranch || "main";
    const execOpts = { cwd, encoding: "utf-8" as const, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 };

    // ── 1. Pull latest ──
    try {
      execSync(`git pull origin ${branch}`, { ...execOpts, stdio: "pipe" });
      logger.info("preExecutionSync: pulled latest", { repoId: repo.id, branch });
    } catch (err) {
      // Non-fatal — repo may have no upstream or network issues
      logger.warn("preExecutionSync: git pull failed", {
        repoId: repo.id,
        branch,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ── 2. Detect structural changes ──
    try {
      const hasArchitecture = !!repo.architectureOverview?.trim();

      // Get files changed in recent commits (since last 7 days or last 20 commits)
      let diffNameOnly = "";
      try {
        diffNameOnly = execSync(
          "git log --name-status --diff-filter=ADRT --pretty=format: -20",
          execOpts,
        ).trim();
      } catch {
        // Fallback: compare against HEAD~10
        try {
          diffNameOnly = execSync("git diff --name-status HEAD~10 HEAD", execOpts).trim();
        } catch {
          // Repo may have <10 commits; skip
          continue;
        }
      }

      if (!diffNameOnly) {
        // No changes — if there's no architecture overview yet, generate one
        if (!hasArchitecture) {
          await generateArchitectureOverview(repo, cwd);
        }
        continue;
      }

      // Check for structural changes: new/deleted files, new directories, config files
      const structuralPatterns = /^[ADR]\t/m;
      const hasStructuralChanges = structuralPatterns.test(diffNameOnly);

      if (!hasStructuralChanges && hasArchitecture) {
        // Only content modifications — architecture hasn't changed
        continue;
      }

      // ── 3. Analyze and update architecture ──
      await generateArchitectureOverview(repo, cwd);
    } catch (err) {
      // Non-fatal — don't block task execution
      logger.warn("preExecutionSync: architecture check failed", {
        repoId: repo.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Spawns a quick Claude CLI call to analyze the repo and produce an
 * architecture overview, then persists it to the repository record.
 */
async function generateArchitectureOverview(
  repo: Repository,
  cwd: string,
): Promise<void> {
  const currentOverview = repo.architectureOverview?.trim() || "(none)";

  const prompt =
    "Analyze this repository's current structure and produce a concise architecture overview. " +
    "Include: top-level folder tree (depth 2), major components and their responsibilities, " +
    "key patterns (e.g. MVC, monorepo, microservices), and entry points. " +
    "Be factual — only describe what exists now.\n\n" +
    "Current stored overview (may be outdated):\n" +
    currentOverview + "\n\n" +
    "Output ONLY the updated architecture overview text — no preamble, no markdown fences, " +
    "no explanation. Keep it under 2000 characters.";

  try {
    const cliResult = spawnSync("su-exec", [
      "agent", "claude",
      "-p", prompt,
      "--dangerously-skip-permissions",
      "--max-turns", "10",
    ], {
      cwd,
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (cliResult.error) throw cliResult.error;
    if (cliResult.status !== 0) throw new Error(cliResult.stderr?.trim() || `claude exited with code ${cliResult.status}`);
    const result = (cliResult.stdout ?? "").trim();

    if (result && result.length > 20 && result.length < 5000) {
      const previous = repo.architectureOverview;
      await repo.update({ architectureOverview: result });
      logger.info("preExecutionSync: updated architecture overview", {
        repoId: repo.id,
        repoName: repo.name,
        previousLength: previous?.length ?? 0,
        newLength: result.length,
      });
    }
  } catch (err) {
    logger.warn("preExecutionSync: Claude CLI architecture analysis failed", {
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
async function buildArchitectureContext(epicId: EpicTaskId): Promise<string> {
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

  return sections.join("\n");
}

// ─── Task Execution via Claude CLI ───────────────────────────────────────────

async function executeTask(
  taskId: AgentTaskId,
  options: {
    cwd: string;
    allowedTools?: string;
    maxTurns?: number;
    systemPrompt?: string;
    promptOverride?: string;
    resumeSessionId?: string;
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

  logger.info("Executing agent task via Claude CLI", {
    taskId,
    executionId: execution.id,
    cwd: options.cwd,
  });

  return new Promise<TaskExecution>((resolve, reject) => {
    const child = spawn("su-exec", ["agent", "claude", ...args], {
      cwd: options.cwd,
      env: { ...process.env },
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

          // Capture git diff after successful execution
          try {
            const gitDiff = captureGitDiff(options.cwd);
            metadata.git_diff_stat = gitDiff.diffStat;
            metadata.git_diff = gitDiff.fullDiff;
            metadata.git_recent_commits = gitDiff.recentCommits;
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
              const gitDiff = captureGitDiff(options.cwd);
              metadata.git_diff_stat = gitDiff.diffStat;
              metadata.git_diff = gitDiff.fullDiff;
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

            // If --resume failed because the session no longer exists, retry without it
            if (
              options.resumeSessionId &&
              (errorMsg.includes("No conversation found") || stdout.includes("No conversation found"))
            ) {
              logger.warn("Session not found — retrying without --resume", {
                taskId,
                sessionId: options.resumeSessionId,
              });
              // Clean up the failed execution before retrying
              await failExecution(execution.id, { error: "Session expired — retrying fresh" });

              try {
                const retryResult = await executeTask(taskId, {
                  ...options,
                  resumeSessionId: undefined,
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

async function createEpicWithPlan(data: {
  title: string;
  description: string;
  projectId: ProjectId;
  userId: UserId;
  agentId: AgentId;
  repositoryIds?: RepositoryId[];
  stages: Array<{
    title: string;
    description?: string;
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

// ─── PR Approval (used by webhook route) ─────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════════════
// LangGraph Tools (bound to orchestrator agent)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Tool for the orchestrator to list all projects the user has access to.
 * Should be called before creating an epic to confirm which project to use.
 */
export function ListProjectsTool(userId: number) {
  return tool(
    async () => {
      try {
        const projects = await listProjects({ userId });
        if (projects.length === 0) {
          return "No projects found for this user. You need to create a project first before creating an epic task.";
        }

        let result = `Found ${projects.length} project(s):\n\n`;
        for (const p of projects) {
          result += `- **${p.name}** (ID: ${p.id})`;
          if (p.description) result += ` — ${p.description}`;
          if (p.techStack) result += `\n  Tech stack: ${p.techStack}`;
          result += "\n";
        }

        result += "\nUse the list_repositories tool to see repositories within a project.";
        return result;
      } catch (err: any) {
        return `Error listing projects: ${err.message}`;
      }
    },
    {
      name: "list_projects",
      description:
        "List all projects belonging to the current user. " +
        "Use this before creating an epic task to identify the correct project and its ID. " +
        "If the user's request doesn't make it clear which project is relevant, show them the list and ask.",
      schema: z.object({}),
    },
  );
}

/**
 * Tool for the orchestrator to list repositories within a project.
 * Should be called before creating an epic to confirm which repos are relevant.
 */
export function ListRepositoriesTool() {
  return tool(
    async (input) => {
      try {
        const project = await getProject(input.projectId);
        if (!project) return `Error: Project ${input.projectId} not found.`;

        const repos = (project as any).repositories ?? [];
        if (repos.length === 0) {
          return `Project "${project.name}" has no repositories configured. Add repositories before creating an epic task.`;
        }

        // Show project-level context if available
        let result = `Project "${project.name}" has ${repos.length} repository(ies):\n`;
        if (project.techStack) result += `Tech stack: ${project.techStack}\n`;
        if (project.architectureOverview) result += `Architecture: ${project.architectureOverview}\n`;
        result += "\n";

        for (const r of repos) {
          result += `- **${r.name}** (ID: ${r.id})`;
          result += `\n  URL: ${r.url}`;
          result += `\n  Default branch: ${r.defaultBranch ?? "main"}`;
          if (r.localPath) result += `\n  Local path: ${r.localPath}`;
          else result += `\n  ⚠ No local path configured — set localPath before executing tasks`;
          if (r.architectureOverview) result += `\n  Architecture: ${r.architectureOverview}`;
          if (r.setupInstructions) result += `\n  Setup: ${r.setupInstructions}`;
          result += "\n";
        }

        result += "\nAll repositories are LOCAL clones on this machine. The executor runs commands locally via Claude CLI — ";
        result += "it does NOT access GitHub remotely.\n";
        result += "When creating an epic task, specify the repositoryIds for only the repos relevant to the task. ";
        result += "The architecture context and localPath from selected repos will be automatically injected into the CLI executor.";
        return result;
      } catch (err: any) {
        return `Error listing repositories: ${err.message}`;
      }
    },
    {
      name: "list_repositories",
      description:
        "List all repositories within a project. " +
        "Use this after identifying the project to determine which repositories are relevant for the epic task. " +
        "Only repositories relevant to the task should be included in the epic — this controls which repo context " +
        "(architecture docs, special instructions, etc.) gets fetched for the executor agents. " +
        "If it's not clear which repos are needed, show the list to the user and ask.",
      schema: z.object({
        projectId: z.string().uuid().describe("The project ID to list repositories for"),
      }),
    },
  );
}

/**
 * Tool for the orchestrator to create a full epic plan in one call.
 */
export function CreateEpicPlanTool(userId: number, agentId: string) {
  return tool(
    async (input) => {
      try {
        // Guard: refuse to create a new epic if ANY epic is already active in
        // the system — across all users and projects. The Epic Orchestrator is
        // a shared singleton agent with a single per-agent thread lock, so
        // exactly one epic can run at a time, system-wide.
        const activeEpic = await EpicTask.findOne({
          where: {
            status: ["pending", "in_progress"],
          },
          order: [["createdAt", "DESC"]],
        });
        if (activeEpic) {
          const sameUser = activeEpic.userId === userId;
          const sameProject = activeEpic.projectId === input.projectId;
          const scopeNote = sameUser
            ? sameProject
              ? `there is already an active epic for this project`
              : `you already have an active epic in another project (projectId: ${activeEpic.projectId})`
            : `another user already has an active epic in the system (userId: ${activeEpic.userId}, projectId: ${activeEpic.projectId})`;
          return (
            `Cannot create a new epic — ${scopeNote}:\n` +
            `- Title: "${activeEpic.title}"\n` +
            `- ID: ${activeEpic.id}\n` +
            `- Status: ${activeEpic.status}\n\n` +
            `Only ONE epic can be active at a time across the entire system. ` +
            `The existing epic must finish or be cancelled before a new one can be created. ` +
            (sameUser
              ? `Use execute_epic_task with epicId "${activeEpic.id}" to continue it, or ask the user whether to cancel it before proceeding.`
              : `Inform the user that another user's epic is currently running and they must wait until it completes.`)
          );
        }

        const epic = await createEpicWithPlan({
          title: input.title,
          description: input.description,
          projectId: input.projectId,
          userId,
          agentId,
          repositoryIds: input.repositoryIds,
          stages: input.stages,
        });

        const fullEpic = await getEpic(epic.id, {
          includeStages: true,
          includeTasks: true,
        });

        const stages = (fullEpic as any)?.stages ?? [];
        let summary = `Epic plan created successfully.\n`;
        summary += `- Epic ID: ${epic.id}\n`;
        summary += `- Title: ${epic.title}\n`;
        summary += `- Stages: ${stages.length}\n\n`;

        for (const stage of stages) {
          const tasks = stage.tasks ?? [];
          summary += `Stage "${stage.title}" (ID: ${stage.id}, order: ${stage.sortOrder}):\n`;
          for (const task of tasks) {
            const deps = task.dependencies ?? [];
            const depInfo = deps.length > 0
              ? ` [depends on: ${deps.map((d: any) => d.title).join(", ")}]`
              : "";
            summary += `  - Task "${task.title}" (ID: ${task.id})${depInfo}\n`;
          }
          summary += "\n";
        }

        const readyTasks = await getReadyTasks(epic.id);
        if (readyTasks.length > 0) {
          summary += `Ready to execute (${readyTasks.length} tasks):\n`;
          for (const t of readyTasks) {
            summary += `  - "${t.title}" (ID: ${t.id})\n`;
          }
        }

        summary += `\nUse the execute_epic_task tool to start executing tasks one by one.`;

        logger.info("CreateEpicPlan: epic created", {
          epicId: epic.id,
          stageCount: stages.length,
          readyCount: readyTasks.length,
        });

        return summary;
      } catch (err: any) {
        logger.error("CreateEpicPlan: failed", { error: err.message });
        return `Error creating epic plan: ${err.message}`;
      }
    },
    {
      name: "create_epic_plan",
      description:
        "Create a full epic task plan for a coding project. This creates an epic with stages (each stage = one PR) " +
        "and agent tasks within each stage — all in one atomic operation. " +
        "Use this after you have analyzed the user's request and broken it down into concrete stages and tasks. " +
        "Each stage groups related tasks that will be submitted together in a single pull request. " +
        "Tasks within a stage are executed sequentially in the order they are defined. " +
        "Cross-stage execution is gated by PR approval — the next stage starts only after the previous stage's PR is approved.",
      schema: z.object({
        title: z.string().min(1).describe("Short title for the epic (e.g. 'Add user authentication')"),
        description: z.string().min(1).describe("Detailed description of the overall task as instructed by the user"),
        projectId: z.string().uuid().describe("The project ID this epic belongs to"),
        repositoryIds: z.array(z.string().uuid()).optional()
          .describe("Repository IDs involved in this epic (from the repositories table)"),
        stages: z.array(z.object({
          title: z.string().min(1).describe("Stage name (e.g. 'Backend API', 'Client side', 'Database migrations')"),
          description: z.string().optional().describe("What this stage covers"),
          tasks: z.array(z.object({
            title: z.string().min(1).describe("Short task title"),
            description: z.string().optional()
              .describe(
                "Detailed instruction for the Claude CLI executor. Be specific about what files to create/modify, " +
                "what logic to implement, and any constraints. This is the prompt that will be sent to Claude CLI.",
              ),
          })),
        })),
      }),
    },
  );
}

/**
 * Tool for the orchestrator to execute the next ready task via Claude CLI.
 * The orchestrator receives the result and can review it — if not satisfied,
 * it can call this tool again with feedback to retry on the same task.
 */
export function ExecuteEpicTaskTool(conversationCtx?: {
  threadId: string;
  userId: number;
  groupId: string | null;
  singleChatId: string | null;
}) {
  return tool(
    async (input) => {
      try {
        // Signal the UI that epic execution has started (replaces "Agent is typing...")
        if (conversationCtx) {
          const { emitAgentTyping } = await import("../socket");
          emitAgentTyping({ ...conversationCtx, isEpicExecution: true });
        }

        // Helper: resolve epic ID from a task ID (for architecture context)
        async function resolveEpicId(taskId: string): Promise<string | null> {
          const t = await AgentTask.findByPk(taskId, {
            include: [{ model: TaskStage, as: "stage" }],
          });
          return (t as any)?.stage?.epicTaskId ?? null;
        }

        // Helper: pull repos, refresh architecture if needed, then build system prompt
        async function buildSystemPrompt(epicId: string | null, userSystemPrompt?: string): Promise<string | undefined> {
          if (epicId) {
            // Pull latest + detect architecture drift before reading context
            await preExecutionSync(epicId);
          }
          const parts: string[] = [];
          if (epicId) {
            const archCtx = await buildArchitectureContext(epicId);
            if (archCtx) parts.push(archCtx);
          }
          if (userSystemPrompt) parts.push(userSystemPrompt);
          return parts.length > 0 ? parts.join("\n\n") : undefined;
        }

        // Helper: resolve cwd — prefer repo.localPath, fall back to input.cwd
        async function resolveCwd(epicId: string | null, inputCwd?: string): Promise<string> {
          if (inputCwd) return inputCwd;
          if (!epicId) throw new Error("cwd is required when epicId is not provided.");

          // Use the first repo's localPath as the working directory
          const epic = await EpicTask.findByPk(epicId, {
            include: [{ model: Repository, as: "repositories" }],
          });
          const repos = ((epic as any)?.repositories ?? []) as Repository[];
          const repoWithPath = repos.find((r) => r.localPath);
          if (repoWithPath?.localPath) return repoWithPath.localPath;

          throw new Error(
            "cwd is required — no repository has a localPath configured. " +
            "Either pass cwd explicitly or set localPath on the repository.",
          );
        }

        if (input.mode === "retry") {
          if (!input.taskId) {
            return "Error: taskId is required for retry mode.";
          }
          if (!input.feedback) {
            return "Error: feedback is required for retry mode — explain what needs to be fixed.";
          }

          const epicId = await resolveEpicId(input.taskId);
          const cwd = await resolveCwd(epicId, input.cwd);
          const systemPrompt = await buildSystemPrompt(epicId, input.systemPrompt);

          const { previousSessionId, enrichedFeedback } = await prepareRetry(input.taskId, input.feedback);

          logger.info("ExecuteEpicTask: retrying task", {
            taskId: input.taskId,
            previousSessionId,
          });

          const execution = await executeTask(input.taskId, {
            cwd,
            promptOverride: enrichedFeedback,
            resumeSessionId: previousSessionId ?? undefined,
            allowedTools: input.allowedTools,
            maxTurns: input.maxTurns,
            systemPrompt,
          });

          let result = await formatExecutionResult(execution, input.taskId);

          // After successful retry, continue with remaining stage tasks
          if (execution.status !== "failed") {
            const contResult = await continueRemainingTasks(input.taskId, {
              cwd, allowedTools: input.allowedTools, maxTurns: input.maxTurns, systemPrompt,
            });
            if (contResult) result += "\n\n---\n\n" + contResult;
          }

          result += await appendContinuationMarker(input.taskId);
          return result;
        }

        // Normal execution mode — single task
        if (input.taskId) {
          const epicId = await resolveEpicId(input.taskId);
          const cwd = await resolveCwd(epicId, input.cwd);
          const systemPrompt = await buildSystemPrompt(epicId, input.systemPrompt);

          const execution = await executeTask(input.taskId, {
            cwd,
            allowedTools: input.allowedTools,
            maxTurns: input.maxTurns,
            systemPrompt,
          });

          let result = await formatExecutionResult(execution, input.taskId);

          // After successful execution, continue with remaining stage tasks
          if (execution.status !== "failed") {
            const contResult = await continueRemainingTasks(input.taskId, {
              cwd, allowedTools: input.allowedTools, maxTurns: input.maxTurns, systemPrompt,
            });
            if (contResult) result += "\n\n---\n\n" + contResult;
          }

          result += await appendContinuationMarker(input.taskId);
          return result;
        }

        if (input.epicId) {
          const readyTasks = await getReadyTasks(input.epicId);
          if (readyTasks.length === 0) {
            const epic = await getEpic(input.epicId, { includeStages: true, includeTasks: true });
            if (!epic) return "Error: Epic not found.";

            const stages = (epic as any).stages ?? [];
            const waitingForPr = stages.filter(
              (s: any) => s.prStatus === "open" || s.prStatus === "draft",
            );

            if (waitingForPr.length > 0) {
              const stageNames = waitingForPr.map((s: any) => `"${s.title}" (PR #${s.prNumber ?? "not opened"})`).join(", ");
              return (
                `No tasks are ready to execute. Waiting for PR approval on stages: ${stageNames}.\n` +
                `Inform the user that the next tasks are blocked until these PRs are approved.`
              );
            }

            if (epic.status === "completed") {
              return `All tasks in epic "${epic.title}" have been completed successfully!`;
            }

            return `No ready tasks found for epic "${epic.title}". Status: ${epic.status}.`;
          }

          const cwd = await resolveCwd(input.epicId, input.cwd);
          const systemPrompt = await buildSystemPrompt(input.epicId, input.systemPrompt);

          // Determine the stage of the first ready task, then get ALL tasks
          // in that stage sorted by sort_order — run them sequentially
          const firstReady = readyTasks[0];
          const stageTasks = await AgentTask.findAll({
            where: { taskStageId: (firstReady as any).task_stage_id ?? (firstReady as any).taskStageId },
            order: [["sort_order", "ASC"]],
          });

          // Filter to tasks that still need to run (pending or ready)
          const tasksToRun = stageTasks.filter(
            (t) => t.status === "pending" || t.status === "ready",
          );

          const results: string[] = [];
          let lastTaskId = firstReady.id;

          for (const task of tasksToRun) {
            logger.info("ExecuteEpicTask: executing stage task", {
              epicId: input.epicId,
              taskId: task.id,
              taskTitle: task.title,
              position: `${tasksToRun.indexOf(task) + 1}/${tasksToRun.length}`,
            });

            const execution = await executeTask(task.id, {
              cwd,
              allowedTools: input.allowedTools,
              maxTurns: input.maxTurns,
              systemPrompt,
            });

            const report = await formatExecutionResult(execution, task.id);
            results.push(report);
            lastTaskId = task.id;

            // If the task failed, stop — don't continue to the next task
            if (execution.status === "failed") {
              results.push(`\n⚠ Task "${task.title}" failed. Stopping sequential execution.`);
              break;
            }
          }

          let result = results.join("\n\n---\n\n");

          // After all stage tasks ran, check if stage needs a PR
          result += await appendContinuationMarker(lastTaskId);

          return result;
        }

        return "Error: either taskId or epicId is required.";
      } catch (err: any) {
        logger.error("ExecuteEpicTask: failed", { error: err.message });
        return `Error executing task: ${err.message}`;
      }
    },
    {
      name: "execute_epic_task",
      description:
        "Execute coding task(s) via Claude CLI. You can either:\n" +
        "1. Specify a taskId to execute a specific task\n" +
        "2. Specify an epicId to automatically execute ALL ready tasks in the current stage sequentially\n" +
        "3. Use mode='retry' with taskId and feedback to re-execute a task that produced unsatisfactory results\n\n" +
        "When using epicId, all ready tasks are executed one after another automatically. " +
        "If a task fails, execution stops. After all tasks in a stage complete, " +
        "you will be instructed to open a PR for the stage.\n\n" +
        "After execution, you will receive a structured report with the git diff and a review checklist.\n" +
        "Review the diff carefully — if fixes are needed, call this tool with mode='retry'.\n\n" +
        "The working directory is resolved automatically from the repository's localPath. " +
        "You can override it with cwd if needed. Architecture context from the project and repos " +
        "is automatically injected into the CLI executor's system prompt.",
      schema: z.object({
        mode: z.enum(["execute", "retry"]).default("execute")
          .describe("'execute' for normal execution, 'retry' to re-run a task with feedback"),
        epicId: z.string().uuid().optional()
          .describe("Epic ID — when provided without taskId, executes the next ready task automatically"),
        taskId: z.string().uuid().optional()
          .describe("Specific task ID to execute or retry"),
        cwd: z.string().optional()
          .describe("Working directory override. If omitted, resolved from the repository's localPath."),
        feedback: z.string().optional()
          .describe("Required for retry mode — detailed feedback on what needs to be fixed"),
        allowedTools: z.string().optional()
          .describe("Comma-separated list of allowed Claude CLI tools (default: 'Bash,Read,Edit,Write,Glob,Grep')"),
        maxTurns: z.number().int().positive().optional()
          .describe("Max number of Claude CLI turns (default: unlimited)"),
        systemPrompt: z.string().optional()
          .describe("Additional system prompt to append for the Claude CLI executor"),
      }),
    },
  );
}

/**
 * Tool for the orchestrator to check the current status of an epic and its tasks.
 */
export function GetEpicStatusTool() {
  return tool(
    async (input) => {
      try {
        const epic = await getEpic(input.epicId, {
          includeStages: true,
          includeTasks: true,
        });
        if (!epic) return "Error: Epic not found.";

        let summary = `Epic: "${epic.title}" — Status: ${epic.status}\n\n`;

        const stages = (epic as any).stages ?? [];
        for (const stage of stages) {
          const tasks = stage.tasks ?? [];
          const prInfo = stage.prUrl
            ? ` | PR: ${stage.prUrl} (${stage.prStatus})`
            : "";
          summary += `Stage "${stage.title}" — ${stage.status}${prInfo}\n`;

          for (const task of tasks) {
            const executions = task.executions ?? [];
            const lastExec = executions[executions.length - 1];
            const execInfo = lastExec
              ? ` [attempt #${lastExec.attemptNumber}, ${lastExec.status}]`
              : "";
            summary += `  ${task.status === "completed" ? "+" : task.status === "failed" ? "x" : "o"} "${task.title}" — ${task.status}${execInfo}\n`;
          }
          summary += "\n";
        }

        const readyTasks = await getReadyTasks(epic.id);
        if (readyTasks.length > 0) {
          summary += `Ready to execute: ${readyTasks.map((t) => `"${t.title}"`).join(", ")}\n`;
        }

        // Flag completed stages that are missing a PR — this blocks the next stage
        for (const stage of stages) {
          if (stage.status === "completed" && !stage.prNumber) {
            summary +=
              `\n⚠ Stage "${stage.title}" is completed but has no PR. ` +
              `PR creation should have happened automatically. If it failed, run: ` +
              `\`git push origin HEAD\` then \`gh pr create\`, then call update_stage_pr.\n`;
          } else if (stage.status === "completed" && stage.prStatus === "changes_requested") {
            summary +=
              `\n⚠ ACTION REQUIRED: Stage "${stage.title}" has changes requested on PR #${stage.prNumber}. ` +
              `Push the fixes and notify the reviewer. The next stage is blocked until the PR is approved.\n`;
          }
        }

        return summary;
      } catch (err: any) {
        return `Error getting epic status: ${err.message}`;
      }
    },
    {
      name: "get_epic_status",
      description:
        "Get the current status of an epic and all its stages/tasks. " +
        "Use this to check progress, see which tasks are completed, failed, or ready to execute.",
      schema: z.object({
        epicId: z.string().uuid().describe("The epic ID to check status for"),
      }),
    },
  );
}

/**
 * Tool for the orchestrator to inspect git changes in a repository on demand.
 * Useful for reviewing diffs before/after execution, checking repo state, etc.
 */
export function ReviewTaskDiffTool() {
  return tool(
    async (input) => {
      try {
        const execOpts = { cwd: input.cwd, encoding: "utf-8" as const, maxBuffer: 2 * 1024 * 1024 };
        let result = `# Repository Review: ${input.cwd}\n\n`;

        // If a specific taskId is provided, show its last execution diff from metadata
        if (input.taskId) {
          const lastExec = await TaskExecution.findOne({
            where: { agentTaskId: input.taskId },
            order: [["attempt_number", "DESC"]],
          });

          if (lastExec?.metadata) {
            const meta = lastExec.metadata as Record<string, unknown>;
            if (meta.git_diff_stat) {
              result += `## Stored Diff from Last Execution (attempt #${lastExec.attemptNumber})\n`;
              result += `\`\`\`\n${meta.git_diff_stat}\n\`\`\`\n\n`;
            }
            if (meta.git_diff) {
              result += `## Stored Full Diff\n`;
              result += `\`\`\`diff\n${meta.git_diff}\n\`\`\`\n\n`;
            }
          }
        }

        // Live git state
        if (input.command === "status" || !input.command) {
          try {
            const status = execSync("git status --short", execOpts).trim();
            result += `## Git Status\n`;
            result += status ? `\`\`\`\n${status}\n\`\`\`\n` : "_Working tree clean_\n";
          } catch (err: any) {
            result += `## Git Status\n_Error: ${err.message}_\n`;
          }
        }

        if (input.command === "diff" || !input.command) {
          try {
            const diffResult = captureGitDiff(input.cwd);
            result += `\n## Diff Stat\n`;
            result += diffResult.diffStat
              ? `\`\`\`\n${diffResult.diffStat}\n\`\`\`\n`
              : "_No changes_\n";
            result += `\n## Full Diff\n`;
            result += diffResult.fullDiff
              ? `\`\`\`diff\n${diffResult.fullDiff}\n\`\`\`\n`
              : "_No changes_\n";
          } catch (err: any) {
            result += `\n## Diff\n_Error: ${err.message}_\n`;
          }
        }

        if (input.command === "log" || !input.command) {
          try {
            const log = execSync("git log --oneline -10", execOpts).trim();
            result += `\n## Recent Commits\n`;
            result += `\`\`\`\n${log}\n\`\`\`\n`;
          } catch (err: any) {
            result += `\n## Recent Commits\n_Error: ${err.message}_\n`;
          }
        }

        if (input.command === "diff-staged") {
          try {
            const staged = execSync("git diff --cached", execOpts).trim();
            result += `\n## Staged Changes\n`;
            result += staged
              ? `\`\`\`diff\n${staged}\n\`\`\`\n`
              : "_No staged changes_\n";
          } catch (err: any) {
            result += `\n## Staged Changes\n_Error: ${err.message}_\n`;
          }
        }

        if (input.command === "diff-branch" && input.baseBranch) {
          try {
            const branchDiff = execSync(
              `git diff ${input.baseBranch}...HEAD --stat`,
              execOpts,
            ).trim();
            result += `\n## Changes vs ${input.baseBranch}\n`;
            result += branchDiff
              ? `\`\`\`\n${branchDiff}\n\`\`\`\n`
              : "_No changes vs base branch_\n";

            const fullBranchDiff = execSync(
              `git diff ${input.baseBranch}...HEAD`,
              execOpts,
            ).trim();
            const truncated = fullBranchDiff.length > 50000
              ? fullBranchDiff.slice(0, 50000) + "\n\n... (truncated)"
              : fullBranchDiff;
            result += `\n## Full Branch Diff\n`;
            result += truncated
              ? `\`\`\`diff\n${truncated}\n\`\`\`\n`
              : "_No changes_\n";
          } catch (err: any) {
            result += `\n## Branch Diff\n_Error: ${err.message}_\n`;
          }
        }

        return result;
      } catch (err: any) {
        return `Error reviewing diff: ${err.message}`;
      }
    },
    {
      name: "review_task_diff",
      description:
        "Inspect the git state of a repository. Use this to review changes made by a task execution, " +
        "check the current diff, view recent commits, or compare against a base branch.\n\n" +
        "Commands:\n" +
        "- (default/omit): Shows git status + diff + recent commits\n" +
        "- 'diff': Show only the current diff\n" +
        "- 'status': Show only git status\n" +
        "- 'log': Show recent commits\n" +
        "- 'diff-staged': Show only staged changes\n" +
        "- 'diff-branch': Compare current HEAD against a base branch (requires baseBranch)\n\n" +
        "Optionally provide a taskId to also see the stored diff from the last execution of that task.",
      schema: z.object({
        cwd: z.string().min(1).describe("Working directory (local path to the repository)"),
        command: z.enum(["diff", "status", "log", "diff-staged", "diff-branch"]).optional()
          .describe("Specific command to run. Omit for a full overview (status + diff + log)."),
        baseBranch: z.string().optional()
          .describe("Base branch for diff-branch command (e.g. 'main', 'develop')"),
        taskId: z.string().uuid().optional()
          .describe("Task ID to also retrieve the stored diff from its last execution"),
      }),
    },
  );
}

// ─── Update Stage PR ────────────────────────────────────────────────────────

/**
 * Tool for the orchestrator to record the PR URL/number on a stage after
 * creating the pull request. This is required so the webhook-based approval
 * flow can match incoming PR events back to the correct stage.
 */
export function UpdateStagePrTool() {
  return tool(
    async (input) => {
      try {
        const stage = await TaskStage.findByPk(input.stageId);
        if (!stage) return `Error: Stage ${input.stageId} not found.`;

        await stage.update({
          prUrl: input.prUrl,
          prNumber: input.prNumber,
          prStatus: (input.prStatus ?? "open") as PrStatus,
          repositoryId: input.repositoryId ?? stage.repositoryId,
        });

        logger.info("Stage PR info updated", {
          stageId: input.stageId,
          prNumber: input.prNumber,
          prUrl: input.prUrl,
        });

        return (
          `Stage "${stage.title}" updated with PR #${input.prNumber}.\n` +
          `PR URL: ${input.prUrl}\n` +
          `Status: ${input.prStatus ?? "open"}\n\n` +
          `The next stage will be unblocked once this PR is approved.`
        );
      } catch (err: any) {
        logger.error("UpdateStagePr: failed", { error: err.message });
        return `Error updating stage PR: ${err.message}`;
      }
    },
    {
      name: "update_stage_pr",
      description:
        "Record the pull request URL and number on a stage after creating the PR. " +
        "This links the stage to the GitHub PR so that the approval webhook can automatically " +
        "unblock the next stage. Call this immediately after creating a PR with `gh pr create`.",
      schema: z.object({
        stageId: z.string().uuid().describe("The stage ID to update"),
        prUrl: z.string().url().describe("Full URL of the pull request (e.g. https://github.com/owner/repo/pull/42)"),
        prNumber: z.number().int().positive().describe("PR number (e.g. 42)"),
        prStatus: z.enum(["open", "draft"]).optional()
          .describe("PR status — defaults to 'open'"),
        repositoryId: z.string().uuid().optional()
          .describe("Repository ID, if not already set on the stage"),
      }),
    },
  );
}

// ─── Force-Approve Stage PR (bypass webhook) ────────────────────────────────

/**
 * DESTRUCTIVE tool — marks a stage's PR as approved without waiting for the
 * real GitHub webhook. Reuses the same service method the webhook uses, so
 * side effects (ready-task unblocking, auto-continuation, epic finalization)
 * are identical to a real approval.
 *
 * Intended usage: the user has manually reviewed and approved the PR outside
 * the system (e.g. on GitHub directly) and explicitly instructs the agent to
 * proceed. The tool REQUIRES the agent to pass a verbatim quote of the user's
 * authorization message to force explicit consent and create an audit trail.
 */
export function ForceApproveStagePrTool() {
  return tool(
    async (input) => {
      try {
        const quote = (input.userConfirmationQuote ?? "").trim();
        if (quote.length < 10) {
          return (
            `Error: force_approve_stage_pr requires 'userConfirmationQuote' — a verbatim ` +
            `quote of the user's explicit authorization to bypass PR approval. ` +
            `This tool must NEVER be called without clear user consent in the conversation.`
          );
        }

        const stage = await TaskStage.findByPk(input.stageId);
        if (!stage) return `Error: Stage ${input.stageId} not found.`;

        if (!stage.repositoryId || !stage.prNumber) {
          return (
            `Error: Stage "${stage.title}" has no PR linked yet (repositoryId or prNumber missing). ` +
            `Cannot force-approve a stage that does not have a PR. ` +
            `Wait for automatic PR creation to complete first.`
          );
        }

        if (stage.prStatus === "approved" || stage.prStatus === "merged") {
          return (
            `Stage "${stage.title}" PR #${stage.prNumber} is already ${stage.prStatus}. ` +
            `No action taken.`
          );
        }

        // Import the service lazily to avoid a circular import at module load
        const { EpicTaskService } = await import("../services/epicTask.service");
        const service = new EpicTaskService();
        const result = await service.handlePrApproval(stage.repositoryId, stage.prNumber);

        logger.warn("Stage PR force-approved by agent (bypass webhook)", {
          stageId: stage.id,
          prNumber: stage.prNumber,
          userQuote: quote,
          readyTaskCount: result.readyTasks.length,
          epicCompleted: result.epicCompleted,
        });

        let summary =
          `Stage "${stage.title}" PR #${stage.prNumber} has been force-approved.\n` +
          `Authorization quote recorded: "${quote}"\n\n`;

        if (result.epicCompleted) {
          summary += `All stages are now complete — the epic is finished.`;
        } else if (result.readyTasks.length > 0) {
          summary +=
            `${result.readyTasks.length} task(s) in the next stage are now ready and will be ` +
            `executed automatically.`;
        } else {
          summary +=
            `No new tasks were unblocked — either later stages are still gated on other PRs, ` +
            `or there are no more stages.`;
        }

        return summary;
      } catch (err: any) {
        logger.error("ForceApproveStagePr: failed", { error: err.message });
        return `Error force-approving stage PR: ${err.message}`;
      }
    },
    {
      name: "force_approve_stage_pr",
      description:
        "DESTRUCTIVE — bypasses the PR review webhook and marks a stage's PR as approved, " +
        "triggering the next stage to start executing. " +
        "USE ONLY when ALL of the following are true: " +
        "(1) the user has stated in THIS conversation that they manually reviewed and approved the PR, " +
        "(2) the user has explicitly instructed you to proceed without waiting for the automatic approval webhook, " +
        "(3) you can quote the exact user message that granted this authorization. " +
        "NEVER call this tool on your own initiative. NEVER use it to 'keep things moving' or to retry a failed webhook. " +
        "If the user has not given explicit, unambiguous consent, refuse and ask them to confirm first. " +
        "The 'userConfirmationQuote' field is mandatory and must contain the verbatim user authorization.",
      schema: z.object({
        stageId: z.string().uuid().describe("The stage ID whose PR should be force-approved"),
        userConfirmationQuote: z.string().min(10).describe(
          "Verbatim quote of the user's message authorizing the bypass. " +
          "Must be the actual text the user wrote in this conversation — not a paraphrase. " +
          "Example: 'I already approved the PR on GitHub, please continue with the next stage'.",
        ),
      }),
    },
  );
}

// ─── Continue Remaining Stage Tasks ─────────────────────────────────────────

/**
 * After a single task or retry completes, run any remaining pending/ready
 * tasks in the same stage sequentially by sort_order.
 */
async function continueRemainingTasks(
  completedTaskId: string,
  options: { cwd: string; allowedTools?: string; maxTurns?: number; systemPrompt?: string },
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

    const execution = await executeTask(next.id, {
      cwd: options.cwd,
      allowedTools: options.allowedTools,
      maxTurns: options.maxTurns,
      systemPrompt: options.systemPrompt,
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

interface AutoPrResult {
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
async function autoCreateStagePr(
  stage: TaskStage,
  repo: Repository,
  epicTitle: string,
): Promise<AutoPrResult> {
  const cwd = repo.localPath;
  if (!cwd) return { ok: false, error: "Repository has no localPath" };

  const baseBranch = repo.defaultBranch || "main";
  const execOpts = { cwd, encoding: "utf-8" as const, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 };

  // 1. Push commits to remote
  try {
    execSync("git push origin HEAD", { ...execOpts, stdio: "pipe" });
    logger.info("autoCreateStagePr: pushed to remote", { stageId: stage.id, cwd });
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

  // Add diff stat if available
  try {
    const diffStat = execSync(`git diff --stat ${baseBranch}...HEAD`, execOpts).trim();
    if (diffStat) {
      bodyParts.push("", "### Changes", "```", diffStat, "```");
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
      ],
      { cwd, encoding: "utf-8", timeout: 60_000 },
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

    // 4. Update the stage record
    await stage.update({
      prUrl,
      prNumber,
      prStatus: "open" as PrStatus,
      repositoryId: repo.id,
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
async function autoPushToExistingPr(
  stage: TaskStage,
  repo: Repository,
): Promise<AutoPrResult> {
  const cwd = repo.localPath;
  if (!cwd) return { ok: false, error: "Repository has no localPath" };

  try {
    execSync("git push origin HEAD", {
      cwd,
      encoding: "utf-8",
      timeout: 60_000,
      stdio: "pipe",
    });

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
async function appendContinuationMarker(taskId: string): Promise<string> {
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

    // No more ready tasks — check if this stage just completed and needs PR action
    const freshStage = await TaskStage.findByPk(stage.id);
    if (freshStage && freshStage.status === "completed") {
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
          return (
            `\n\n## Fixes Pushed to PR #${freshStage.prNumber}\n\n` +
            `All retry tasks completed and fixes have been pushed automatically.\n` +
            `PR: ${freshStage.prUrl ?? `#${freshStage.prNumber}`}\n` +
            `The next stage is blocked until this PR is approved.`
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
          return (
            `\n\n## Pull Request Created Automatically\n\n` +
            `**PR #${prResult.prNumber}:** ${prResult.prUrl}\n` +
            `Stage "${freshStage.title}" is now waiting for PR approval.\n` +
            `The next stage will begin automatically once the PR is approved.`
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

async function formatExecutionResult(execution: any, taskId: string): Promise<string> {
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

    result += `\n**Action:** If the changes are correct, proceed to the next task. `;
    result += `If fixes are needed, call \`execute_epic_task\` with \`mode='retry'\` and provide **specific feedback** referencing the diff lines that need to change.`;
  } else if (status === "failed") {
    result += `\n## Error\n`;
    result += `\`\`\`\n${execution.error ?? "Unknown error"}\n\`\`\`\n`;
    result += `\nThe task failed. You can retry with \`mode='retry'\` and feedback, or investigate the error.`;
  }

  return result;
}
