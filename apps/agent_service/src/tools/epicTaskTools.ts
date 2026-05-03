import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { execSync } from "child_process";
import fs from "node:fs";
import path from "node:path";
import { Op, QueryTypes } from "sequelize";
import {
  sequelize,
  Agent,
  Repository,
  EpicTask,
  TaskStage,
  AgentTask,
  TaskExecution,
} from "@scheduling-agent/database";
import { runCodexInRepo } from "../chat/codex/codexInRepo";
import { loadCodexAuthObjectForAgent } from "../utils/codexAuthJson.service";
import { resolveOrgVendor } from "../utils/resolveOrgVendor.service";
import { resolveModelSlug } from "../chat/modelResolution";
import { ensureSessionWorkspace } from "../workspace/sessionWorkspace";
import type {
  AgentTaskStatus,
  TaskStageStatus,
  TaskExecutionStatus,
  EpicTaskStatus,
  PrStatus,
} from "@scheduling-agent/types";
import { logger } from "../logger";
import { agentChatQueue } from "../queues/agentChat.bull";
import {
  listProjects,
  getProject,
  getEpic,
  getReadyTasks,
  advanceNextStageReadyTasks,
  advanceNextTaskInStage,
  createEpicWithPlan,
  preExecutionSync,
  buildArchitectureContext,
  buildTaskSummaryFilePath,
  captureGitDiff,
  captureStageDiff,
  appendContinuationMarker,
  resolveActiveEpic,
  resolveActivePrPendingStage,
  resolveNextRetryableTask,
  startExecution,
  completeExecution,
  failExecution,
  updateTaskStatus,
  recordTaskSummaryFilePath,
  gitAsAgent,
  ensureWorkingTreeCommitted,
  EPIC_CONTINUATION_MARKER,
  parseContinuationMarker,
} from "../utils/epicTaskUtils";
import { buildAttachmentUrl } from "./sendFileTool";

// Re-export utils that are imported by other modules
export { getReadyTasks, parseContinuationMarker, EPIC_CONTINUATION_MARKER };

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
 *
 * Returns ONLY a lightweight index (id, name, default branch) so the
 * orchestrator can pick the relevant repos without bloating the model
 * context. Use `get_repository` to fetch the full record (URL, local path,
 * architecture overview, setup instructions) for a single repo.
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

        let result = `Project "${project.name}" has ${repos.length} repository(ies):\n\n`;
        for (const r of repos) {
          result += `- **${r.name}** (ID: ${r.id}, branch: ${r.defaultBranch ?? "main"})\n`;
        }

        result += "\nThis is an index only — call `get_repository` with one of the IDs above to fetch the full record ";
        result += "(URL, local path, architecture overview, setup instructions). ";
        result += "When creating an epic task, specify the repositoryIds for only the repos relevant to the task.";
        return result;
      } catch (err: any) {
        return `Error listing repositories: ${err.message}`;
      }
    },
    {
      name: "list_repositories",
      description:
        "List all repositories within a project. Returns ONLY an index (id, name, default branch) — " +
        "no architecture overview, URL, local path, or setup instructions. Use this to pick which repo(s) " +
        "are relevant, then call `get_repository` for the full record of each one you need. " +
        "If it's not clear which repos are needed, show the list to the user and ask.",
      schema: z.object({
        projectId: z.string().uuid().describe("The project ID to list repositories for"),
      }),
    },
  );
}

/**
 * Tool for the orchestrator to fetch the full record of a single repository.
 *
 * Companion to `list_repositories` — that tool returns only IDs; this one
 * returns the heavy fields (URL, local path, architecture overview, setup
 * instructions) for one repo at a time so the orchestrator only pays the
 * context cost for repos it actually selects.
 */
export function GetRepositoryTool() {
  return tool(
    async (input) => {
      try {
        const repo = await Repository.findByPk(input.repositoryId);
        if (!repo) return `Error: Repository ${input.repositoryId} not found.`;

        let result = `**${repo.name}** (ID: ${repo.id})\n`;
        result += `- URL: ${repo.url}\n`;
        result += `- Default branch: ${repo.defaultBranch ?? "main"}\n`;
        if (repo.localPath) result += `- Local path: ${repo.localPath}\n`;
        else result += `- ⚠ No local path configured — set localPath before executing tasks\n`;
        if (repo.architectureOverview) result += `\nArchitecture overview:\n${repo.architectureOverview}\n`;
        if (repo.setupInstructions) result += `\nSetup instructions:\n${repo.setupInstructions}\n`;

        result += "\nThis repository is a LOCAL clone on this machine. The executor runs commands locally via Claude CLI — ";
        result += "it does NOT access GitHub remotely.";
        return result;
      } catch (err: any) {
        return `Error fetching repository: ${err.message}`;
      }
    },
    {
      name: "get_repository",
      description:
        "Fetch the full record for a single repository by ID — URL, local path, default branch, " +
        "architecture overview, and setup instructions. Call this after `list_repositories` for each repo " +
        "you actually need detail on. The architecture context and localPath returned here are what gets " +
        "injected into the executor agents when an epic task runs.",
      schema: z.object({
        repositoryId: z.string().uuid().describe("The repository ID to fetch (from `list_repositories`)"),
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
        //
        // `failed` is intentionally included here (matches `resolveActiveEpic`):
        // failure is per-task and recoverable, so a `failed`-status epic still
        // holds the singleton slot — it must be resumed via the existing retry
        // path or explicitly cancelled via `cancel_epic` before a new epic can
        // be created. (Legacy rows from before the propagation rule was
        // changed may still sit at `failed`; same handling applies.)
        const activeEpic = await EpicTask.findOne({
          where: {
            status: ["pending", "in_progress", "failed"],
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
              ? `Use execute_epic_task to continue it (no IDs needed — it auto-resolves the active epic), or ask the user whether to cancel it before proceeding.`
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
        "Create a full epic task plan for a coding project. This creates an epic with stages and agent tasks within " +
        "each stage — all in one atomic operation. Use this after you have analyzed the user's request and broken it " +
        "down into concrete stages and tasks. Tasks within a stage are executed sequentially in the order they are defined.\n\n" +
        "Every stage requires explicit user approval before the next stage starts — call `approve_stage` with the user's " +
        "verbatim approval quote.\n\n" +
        "Stage kinds:\n" +
        "- 'code_change' (default): the stage produces commits and a pull request. The user reviews the PR; once they " +
        "approve, the next stage's tasks are unblocked automatically.\n" +
        "- 'plan': pure research/design/specification work that produces NO code changes. No commits, no PR. The user " +
        "reviews the plan/spec text in the chat itself — the orchestrator must summarize it, ask for approval, then call " +
        "`approve_stage` with their verbatim quote. Use this for stages whose task descriptions explicitly say " +
        "'planning only', 'no code changes', 'produce a spec', etc.",
      schema: z.object({
        title: z.string().min(1).describe("Short title for the epic (e.g. 'Add user authentication')"),
        description: z.string().min(1).describe("Detailed description of the overall task as instructed by the user"),
        projectId: z.string().uuid().describe("The project ID this epic belongs to"),
        repositoryIds: z.array(z.string().uuid()).optional()
          .describe("Repository IDs involved in this epic (from the repositories table)"),
        stages: z.array(z.object({
          title: z.string().min(1).describe("Stage name (e.g. 'Backend API', 'Client side', 'Database migrations')"),
          description: z.string().optional().describe("What this stage covers"),
          kind: z.enum(["code_change", "plan"]).optional()
            .describe(
              "Stage kind. Default 'code_change' — produces a PR. Use 'plan' for stages that are pure " +
              "planning/research/spec work with no code changes; those stages skip PR creation and auto-unblock the next stage.",
            ),
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

// ═══════════════════════════════════════════════════════════════════════════════
// Sub-agent driven epic-task lifecycle (slice 20)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Two thin lifecycle tools that bracket the model's NATIVE Claude Agent SDK
// `Task("<sub-agent>", "<scope>")` flow:
//
//   1. `start_epic_task` — picks the next ready task, syncs the stage branch,
//      marks the task in_progress, snapshots HEAD on the repo, creates a
//      task_executions row. Returns the task description + cwd to the model
//      and instructs it to dispatch parallel `Task()` calls.
//   2. The MODEL invokes `Task()` once per concern slice in a single
//      assistant message — the SDK runs them concurrently inline.
//   3. `complete_epic_task` — picks the in-progress task, captures the git
//      diff vs. the snapshot, commits leftover changes, marks the task
//      completed/failed, persists a summary file, appends the
//      EPIC_CONTINUATION marker so the worker auto-enqueues the next task.
//
// The deliberate switch away from the legacy CLI-based `execute_epic_task`:
// each task can now be decomposed into per-concern slices (frontend / backend
// / DB / etc.) and executed in parallel by specialist `claude_sub_agent`
// rows attached to the orchestrator. The orchestrator no longer farms the
// whole task to a Claude CLI subprocess; it composes the slices itself
// and the SDK runs them concurrently as native sub-agents.

interface InProgressExecutionContext {
  task: AgentTask;
  execution: TaskExecution;
  epicId: string;
  cwd: string;
  preRunSha: string | null;
}

/**
 * Shared finalize path for `complete_epic_task` and server-side Codex auto-finalize.
 */
async function finalizeEpicTaskExecution(params: {
  ctx: InProgressExecutionContext;
  epicAgentId: string | null | undefined;
  summary: string;
  status: "completed" | "failed";
  failureReason: string | null;
  conversationCtx?: { threadId: string; userId: number };
  executionMetadataPatch?: Record<string, unknown>;
}): Promise<{
  heading: string;
  summary: string;
  continuation: string;
  attachmentMarkdown: string | null;
}> {
  const { ctx, epicAgentId, summary, status, failureReason, conversationCtx, executionMetadataPatch } =
    params;
  const { task, execution, cwd, preRunSha } = ctx;

  const metadata: Record<string, unknown> = { ...(executionMetadataPatch ?? {}) };
  if (preRunSha) metadata.pre_run_sha_at_start = preRunSha;
  if (status === "completed") {
    try {
      const autoCommit = ensureWorkingTreeCommitted(cwd, task.title);
      if (autoCommit.committed) {
        metadata.auto_committed = true;
        metadata.auto_commit_message = autoCommit.message;
      }
    } catch (err: any) {
      logger.warn("finalizeEpicTaskExecution: safety-net auto-commit failed", {
        taskId: task.id,
        cwd,
        error: err?.message,
      });
    }
  }

  try {
    const gitDiff = captureGitDiff(cwd, preRunSha);
    metadata.git_diff_stat = gitDiff.diffStat;
    metadata.git_diff = gitDiff.fullDiff;
    metadata.git_recent_commits = gitDiff.recentCommits;
    if (preRunSha) metadata.git_diff_base_sha = preRunSha;
  } catch (err: any) {
    logger.warn("finalizeEpicTaskExecution: failed to capture git diff", {
      taskId: task.id,
      error: err?.message,
    });
  }

  if (status === "completed") {
    await completeExecution(execution.id, {
      result: summary,
      metadata,
    });
  } else {
    await failExecution(execution.id, {
      error: failureReason!,
      metadata: { ...metadata, summary },
    });
  }
  await updateTaskStatus(task.id, status as AgentTaskStatus);

  // Build the per-task summary file + a chat-attachment markdown link the
  // orchestrator includes in its reply, so the user receives the summary as
  // a downloadable file in chat after every task (per-task pause flow).
  let attachmentMarkdown: string | null = null;
  if (conversationCtx?.threadId && conversationCtx?.userId !== undefined && epicAgentId) {
    const summaryPath = await buildTaskSummaryFilePath({
      agentId: epicAgentId,
      threadId: conversationCtx.threadId,
      taskId: task.id,
    });
    if (summaryPath) {
      try {
        fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
        const header =
          `# ${task.title}\n\n` +
          `**Status:** ${status}` +
          (failureReason ? `\n**Failure reason:** ${failureReason}` : "") +
          `\n\n`;
        fs.writeFileSync(summaryPath, header + summary, "utf8");
        await recordTaskSummaryFilePath(task.id, summaryPath);

        // Build the [📎 ...](signed-url) markdown using the same helper
        // `send_file_to_user` uses. The path layout is the deterministic one
        // from `buildTaskSummaryFilePath`: `<workspace>/threads/<threadId>/<file>`,
        // so the relative-to-workspace name is `threads/<threadId>/<basename>`.
        const baseName = path.basename(summaryPath);
        const relativeName = `threads/${conversationCtx.threadId}/${baseName}`;
        const url = buildAttachmentUrl(epicAgentId, relativeName);
        attachmentMarkdown = `[📎 ${baseName}](${url})`;
      } catch (err: any) {
        logger.warn("finalizeEpicTaskExecution: summary file write failed", {
          taskId: task.id,
          summaryPath,
          error: err?.message,
        });
      }
    }
  }

  // Sequential-within-stage: hand the baton to the next sibling task only
  // when the just-completed task succeeded. A failed task stays in the
  // failed state and is retried via the existing fallback path — promoting
  // the next sibling there would let work jump over a failure.
  if (status === "completed") {
    try {
      await advanceNextTaskInStage(task.id);
    } catch (err: any) {
      logger.warn("finalizeEpicTaskExecution: advanceNextTaskInStage failed", {
        taskId: task.id,
        error: err?.message,
      });
    }
  }

  const continuation = await appendContinuationMarker(task.id);
  const heading =
    status === "completed" ? `# Task Completed: ${task.title}` : `# Task Failed: ${task.title}`;
  return { heading, summary, continuation, attachmentMarkdown };
}

/**
 * After a background Codex finalize, enqueue a system follow-up that wakes
 * the orchestrator just long enough to deliver the per-task summary file to
 * the user as a chat attachment and then pause.
 *
 * Per-task pause invariant:
 *  - When more tasks remain in the epic, `continuationSuffix` is empty (the
 *    legacy EPIC_CONTINUATION marker is no longer emitted in that case) — we
 *    still enqueue a follow-up so the user sees the summary attachment, and
 *    the prompt explicitly tells the orchestrator NOT to start the next task.
 *  - When the whole stage just finished, `continuationSuffix` carries the
 *    PR-created / plan-awaiting-approval text. We forward it so the user
 *    learns what they need to act on.
 *
 * The legacy marker branch stays as a defensive fallback in case any other
 * code path emits one — it routes into the same pause-and-show prompt
 * instead of triggering auto-continuation.
 */
async function enqueueEpicPostCodexFinalizeTurn(opts: {
  epicUserId: number;
  agentId: string;
  groupId: string | null;
  singleChatId: string | null;
  heading: string;
  summary: string;
  attachmentMarkdown: string | null;
  continuationSuffix: string;
}): Promise<void> {
  try {
    const markerPayload = parseContinuationMarker(opts.continuationSuffix);
    // Strip the marker out of any text we forward to the orchestrator —
    // there should be none post-change, but defend against any other path.
    const stripMarker = (text: string): string => {
      const idx = text.indexOf(EPIC_CONTINUATION_MARKER);
      if (idx === -1) return text;
      const end = text.indexOf("-->", idx);
      return end === -1 ? text.slice(0, idx) : text.slice(0, idx) + text.slice(end + 3);
    };
    const continuationText = stripMarker(opts.continuationSuffix).trim();

    const attachmentBlock = opts.attachmentMarkdown
      ? `\n\n**Summary file (deliver to the user):** ${opts.attachmentMarkdown}`
      : "";
    const stageFollowup = continuationText ? `\n\n${continuationText}` : "";
    const pauseHint =
      `\n\n[System: Codex finished this task server-side. Reply to the user ` +
      `with a brief progress update and include the summary attachment ` +
      `markdown above verbatim so the user gets the file. ` +
      (markerPayload || continuationText
        ? `Then act on the stage-level follow-up text above (if any). `
        : ``) +
      `Do NOT call any more tools to start the next task. Wait for the ` +
      `user to explicitly tell you to continue.]`;

    const body = `${opts.heading}\n\n${opts.summary}${attachmentBlock}${stageFollowup}${pauseHint}`;

    const contRequestId = `epic-codex-finalize-followup-${Date.now()}`;
    await agentChatQueue.add("epic_codex_finalize_followup", {
      userId: opts.epicUserId,
      message: body,
      requestId: contRequestId,
      groupId: opts.groupId,
      singleChatId: opts.singleChatId,
      agentId: opts.agentId,
      mentionsAgent: true,
      displayName: "System",
    } as any);
    logger.info("enqueueEpicPostCodexFinalizeTurn: pause follow-up enqueued", {
      contRequestId,
      hasStageFollowup: continuationText.length > 0,
      hasAttachment: !!opts.attachmentMarkdown,
      legacyMarkerSeen: !!markerPayload,
    });
  } catch (err: any) {
    logger.error("enqueueEpicPostCodexFinalizeTurn: failed to enqueue", {
      error: err?.message,
    });
  }
}

/** True when an in_progress task has a running Codex execution flagged in metadata. */
async function epicHasDetachedCodexInflight(epicId: string): Promise<boolean> {
  const task = await AgentTask.findOne({
    where: { status: "in_progress" as AgentTaskStatus },
    include: [
      {
        model: TaskStage,
        as: "stage",
        where: { epicTaskId: epicId },
        required: true,
      },
    ],
    order: [["startedAt", "DESC"]],
  });
  if (!task) return false;

  const exec = await TaskExecution.findOne({
    where: { agentTaskId: task.id, status: "running" as TaskExecutionStatus },
    order: [["attemptNumber", "DESC"]],
  });
  const meta = (exec?.metadata ?? {}) as Record<string, unknown>;
  return !!(exec && meta.codex_run_in_flight === true);
}

/**
 * Resolves the active epic's currently-running task + its task_executions row.
 * `complete_epic_task` uses this — `start_epic_task` carries the values
 * forward in-process, so it doesn't need the lookup. Returns null when no
 * task is in_progress (orchestrator called complete without a matching
 * start, or the task already finished).
 */
async function resolveInProgressExecution(): Promise<InProgressExecutionContext | null> {
  const epic = await resolveActiveEpic();
  const task = await AgentTask.findOne({
    where: { status: "in_progress" as AgentTaskStatus },
    include: [
      {
        model: TaskStage,
        as: "stage",
        where: { epicTaskId: epic.id },
        required: true,
      },
    ],
    order: [["startedAt", "DESC"]],
  });
  if (!task) return null;

  const execution = await TaskExecution.findOne({
    where: { agentTaskId: task.id, status: "running" as TaskExecutionStatus },
    order: [["attemptNumber", "DESC"]],
  });
  if (!execution) return null;

  // Resolve cwd from the epic's first repo with a localPath (same logic
  // ExecuteEpicTaskTool used). Without a cwd we can't capture the diff
  // or commit, so this is a hard requirement.
  const withRepos = await EpicTask.findByPk(epic.id, {
    include: [{ model: Repository, as: "repositories" }],
  });
  const repos = ((withRepos as any)?.repositories ?? []) as Repository[];
  const repo = repos.find((r) => r.localPath);
  if (!repo?.localPath) {
    throw new Error(
      "complete_epic_task: no repository has a localPath configured — cannot capture diff.",
    );
  }

  const meta = (execution.metadata ?? {}) as Record<string, unknown>;
  const preRunSha =
    typeof meta.pre_run_sha === "string" ? (meta.pre_run_sha as string) : null;

  return {
    task,
    execution,
    epicId: epic.id,
    cwd: repo.localPath,
    preRunSha,
  };
}

/**
 * Begin work on the next ready task. Auto-resolves the active epic + task
 * (the orchestrator is a system-wide singleton — no IDs from the model,
 * which would invite hallucination), but REQUIRES the orchestrator to
 * declare its slice plan up front via the `assignments` parameter.
 *
 * The contract:
 *   - Each `assignment.subagentSlug` MUST be one of the orchestrator's
 *     own `claude_sub_agent` rows (validated against
 *     `owning_primary_agent_id = callerAgentId`). System / external /
 *     application / primary rows are rejected — those have other
 *     runtimes (deep-agent worker, REST endpoint, roundtable graph) and
 *     don't belong in the SDK's `Task()` map.
 *   - The validation runs BEFORE any state mutation (preExecutionSync,
 *     status flip, execution row). A bad slug fails the call without
 *     leaving a half-started task in the DB.
 *   - The returned message echoes the validated assignments back so the
 *     orchestrator can construct its parallel `Task()` dispatch directly
 *     from the same data structure it submitted.
 *
 * After validation: same lifecycle as before — preExecutionSync, mark
 * in_progress, snapshot HEAD onto execution.metadata, start the
 * execution row.
 */
export function StartAnthropicEpicTaskTool(callerAgentId: string) {
  return tool(
    async (input) => {
      try {
        // Sub-agent fan-out is OPTIONAL. When the orchestrator wants to slice
        // the task across specialist `claude_sub_agent` rows, it passes
        // `assignments` and we validate each one. When it omits assignments
        // (or passes an empty list), the orchestrator does the work itself
        // in this same turn using its own filesystem MCP / Bash tools — the
        // start/complete bookkeeping (HEAD snapshot, status flip, diff
        // capture) is identical either way.
        const assignments = input.assignments ?? [];
        if (assignments.length > 0) {
          // Reject duplicate ids — the SDK's `agents:` map is keyed by id,
          // and dispatching the same sub-agent twice with different scopes
          // inside one task would race on the same row's session state. If
          // you need that pattern, run two separate tasks.
          const seenIds = new Set<string>();
          for (const a of assignments) {
            if (seenIds.has(a.id)) {
              return (
                `Error: sub-agent "${a.id}" appears in \`assignments\` ` +
                `more than once. Each id may be used at most once per task.`
              );
            }
            seenIds.add(a.id);
            if (!a.scope || !a.scope.trim()) {
              return (
                `Error: assignment for "${a.id}" has an empty scope. ` +
                `Each assignment needs a self-contained instruction telling that ` +
                `sub-agent which files to look at + change.`
              );
            }
          }

          // Validate every declared id is a claude_sub_agent owned by THIS
          // orchestrator. Type and ownership are both required — system
          // agents are never invocable through SDK Task() (slice 17), and
          // another primary's sub-agent is invisible from this session.
          const callerAgent = await Agent.findByPk(callerAgentId, {
            attributes: ["id", "organizationId"],
          });
          if (!callerAgent) {
            return `Error: caller agent "${callerAgentId}" not found.`;
          }
          const ids = assignments.map((a) => a.id);
          const subAgentRows = await Agent.findAll({
            where: {
              id: { [Op.in]: ids },
              type: "claude_sub_agent",
              owningPrimaryAgentId: callerAgentId,
              organizationId: callerAgent.organizationId,
            },
            attributes: ["id", "slug", "agentName"],
          });
          const validIdsSet = new Set(
            subAgentRows
              .map((r) => r.id)
              .filter((id): id is string => typeof id === "string"),
          );
          const invalid = ids.filter((id) => !validIdsSet.has(id));
          if (invalid.length > 0) {
            return (
              `Error: the following sub-agent id(s) are not attached to you ` +
              `or are not of type \`claude_sub_agent\`: ${invalid.map((id) => `"${id}"`).join(", ")}. ` +
              `Run \`list_claude_sub_agents\` to see your actual roster. ` +
              `Reminder: \`Task()\` only reaches \`claude_sub_agent\` rows — system ` +
              `agents go through \`delegate_to_deep_agent\` instead.`
            );
          }
        }

        const epic = await resolveActiveEpic();
        const next = await resolveNextRetryableTask(epic.id);
        if (!next) {
          return (
            `No tasks are ready to execute on epic "${epic.title}" ` +
            `(status: ${epic.status}). Use get_epic_status to inspect ` +
            `pending stages, or wait for review/approval if any stage ` +
            `is awaiting it.`
          );
        }

        // Resolve cwd before mutating any state — if the repo isn't
        // configured properly we fail loudly rather than leave a half-
        // started task.
        const withRepos = await EpicTask.findByPk(epic.id, {
          include: [{ model: Repository, as: "repositories" }],
        });
        const repos = ((withRepos as any)?.repositories ?? []) as Repository[];
        const repo = repos.find((r) => r.localPath);
        if (!repo?.localPath) {
          return (
            `Error: cannot start task — no repository has a localPath ` +
            `configured for epic "${epic.title}". Set localPath on the ` +
            `repository before starting epic work.`
          );
        }
        const cwd = repo.localPath;

        // Branch sync + base-SHA snapshot. preExecutionSync also pushes
        // the stage's feature branch when first created, so this also
        // bootstraps the branch the orchestrator will land its sub-
        // agents' commits on.
        await preExecutionSync(epic.id, next.id);

        // Mark in_progress + create the execution row up front so a
        // mid-task crash leaves a recoverable trail. Snapshot HEAD on
        // the matching execution.metadata so complete_epic_task can
        // diff against it. Persist the validated assignment plan too —
        // gives `complete_epic_task` the audit trail of what was
        // declared vs. what actually got dispatched.
        await next.update({
          status: "in_progress" as AgentTaskStatus,
          startedAt: next.startedAt ?? new Date(),
          completedAt: null,
        });

        let preRunSha: string | null = null;
        try {
          preRunSha = gitAsAgent(cwd, ["rev-parse", "HEAD"]) || null;
        } catch (err: any) {
          logger.warn("StartEpicTask: failed to snapshot HEAD (non-fatal)", {
            taskId: next.id,
            cwd,
            error: err?.message,
          });
        }

        const execution = await startExecution(next.id, {
          prompt: next.description ?? next.title,
          metadata: {
            ...(preRunSha ? { pre_run_sha: preRunSha } : {}),
            assignments: assignments.map((a) => ({
              id: a.id,
              scope: a.scope,
            })),
          },
        });

        const stage = (next as any).stage as TaskStage | undefined;
        const stageLabel = stage
          ? `Stage "${stage.title}" (${stage.kind})`
          : "Stage (unknown)";

        const repoBlock =
          `## Repository\n` +
          `Working directory: \`${cwd}\`\n` +
          `Branch base SHA: ${preRunSha ?? "(unknown — diff capture may be empty)"}\n\n`;

        const taskBlock =
          `# Epic Task Started\n\n` +
          `**Task:** ${next.title}\n` +
          `**${stageLabel}**\n\n` +
          `## Description\n${next.description ?? "(no description)"}\n\n` +
          repoBlock;

        const trailer =
          `Execution ID: \`${execution.id}\` (carried implicitly — \`complete_epic_task\` resolves it ` +
          `automatically, no need to pass it back).`;

        if (assignments.length === 0) {
          // Sync in-process path: orchestrator does the work itself in this
          // same turn using its own MCP filesystem / Bash tools, then calls
          // `complete_epic_task` to finalize. No sub-agent fan-out.
          return (
            taskBlock +
            `## Execution mode\n` +
            `Direct (no sub-agent fan-out). Do the work yourself in this turn ` +
            `using your bound tools (filesystem MCP \`read_file\` / \`write_file\` / ` +
            `\`edit_file\`, Bash for git/tests/builds, etc.).\n\n` +
            `## Now do this\n` +
            `1. Make the file edits required by the task description above. Stay ` +
            `strictly within scope — no unrelated refactors or rename churn.\n` +
            `2. Run any tests / type checks the project provides. Commit logical ` +
            `units locally as you go (the stage feature branch is already checked out).\n` +
            `3. Call \`complete_epic_task\` with a markdown \`summary\` of what ` +
            `changed (include a \`## Files changed\` list) and \`status\`. The diff ` +
            `vs. the base SHA above is captured automatically.\n\n` +
            trailer
          );
        }

        // Echo the validated plan back so the orchestrator can copy each
        // Task() call directly from this section. We don't issue the Task()
        // calls server-side — that's the model's native SDK flow — but
        // listing them here turns the dispatch into a mechanical translation.
        const dispatchLines = assignments
          .map(
            (a, i) =>
              `${i + 1}. \`Task("${a.id}", ${JSON.stringify(a.scope)})\``,
          )
          .join("\n");

        return (
          taskBlock +
          `## Execution mode\n` +
          `Sub-agent fan-out (${assignments.length} slice(s)).\n\n` +
          `## Your declared dispatch plan\n` +
          `${dispatchLines}\n\n` +
          `## Now do this\n` +
          `1. Emit the \`Task()\` calls listed above **in a single assistant message** so the ` +
          `SDK runs them concurrently. (Splitting them across messages serializes execution.)\n` +
          `2. Wait for ALL \`Task()\` results to return in your tool-loop. Each result includes ` +
          `that sub-agent's \`## Files changed\` section.\n` +
          `3. Call \`complete_epic_task\` with an aggregated summary and the final status. The ` +
          `diff vs. the base SHA above is captured automatically.\n\n` +
          trailer
        );
      } catch (err: any) {
        logger.error("StartEpicTask: failed", {
          error: err?.message,
          stack: err?.stack,
        });
        return `Error starting epic task: ${err?.message ?? String(err)}`;
      }
    },
    {
      name: "start_epic_task",
      description:
        "Begin work on the next ready task in the active epic. Auto-resolves the epic + task — no " +
        "IDs needed. Sub-agent fan-out is OPTIONAL: pass `assignments` to slice the task across " +
        "`claude_sub_agent` specialists you own (each gets a scoped `Task()` call), or omit it " +
        "entirely to do the work yourself in this turn using your bound filesystem MCP / Bash " +
        "tools. Either way, the tool snapshots HEAD, marks the task in_progress, and returns the " +
        "cwd + base SHA. When you're done, call `complete_epic_task` with a summary — the diff " +
        "is captured automatically. **Replaces the legacy `execute_epic_task` Claude CLI flow.**",
      schema: z.object({
        assignments: z
          .array(
            z.object({
              id: z
                .string()
                .min(1)
                .describe(
                  "The sub-agent's id as returned by `list_claude_sub_agents`. Must be a " +
                  "`claude_sub_agent` row attached to you — system / external / application / " +
                  "primary rows are rejected.",
                ),
              scope: z
                .string()
                .min(1)
                .describe(
                  "Self-contained instruction for this sub-agent. Tell it which repo files to " +
                  "look at + change, scoped strictly to its concern (frontend / backend / DB / " +
                  "docs / …). Sub-agents don't see each other's outputs, so the scope must be " +
                  "complete on its own.",
                ),
            }),
          )
          .optional()
          .describe(
            "OPTIONAL. Omit (or pass `[]`) to execute the task yourself directly in this turn. " +
            "When provided, one entry per sub-agent you're fanning the task out across — a " +
            "typical full-stack slice has 2-4 entries (frontend + backend + DB ± docs). Each id " +
            "must be a `claude_sub_agent` attached to you; bad ids are rejected before any " +
            "state changes.",
          ),
      }),
    },
  );
}

/**
 * Finalize the in-progress epic task. Captures the git diff against the
 * pre-start HEAD, commits any leftover changes (success path only), updates
 * the task_executions row, flips the task status, persists a per-task
 * summary file (so `send_file_to_user` can surface the work later), and
 * appends the EPIC_CONTINUATION marker so the worker auto-enqueues the
 * next task.
 */
export function CompleteEpicTaskTool(conversationCtx?: {
  threadId: string;
  userId: number;
  groupId: string | null;
  singleChatId: string | null;
}) {
  return tool(
    async (input) => {
      try {
        const ctx = await resolveInProgressExecution();
        if (!ctx) {
          return (
            `Error: no in_progress task found for the active epic. ` +
            `Either you forgot to call \`start_epic_task\` first, or the ` +
            `task already completed and you're calling complete twice.`
          );
        }
        const { task, execution, epicId, cwd, preRunSha } = ctx;

        const epic = await EpicTask.findByPk(epicId, {
          attributes: ["id", "agentId"],
        });

        const status = input.status === "failed" ? "failed" : "completed";
        const failureReason = input.failureReason?.trim() ?? null;
        if (status === "failed" && !failureReason) {
          return (
            `Error: status="failed" requires a non-empty failureReason ` +
            `explaining what went wrong. Pass it so the next attempt's ` +
            `retry can use it as feedback.`
          );
        }
        const summary = input.summary.trim();
        if (!summary) {
          return (
            `Error: summary cannot be empty. Provide a Markdown summary of ` +
            `what changed (aggregate each sub-agent's report when fan-out was ` +
            `used, otherwise summarize your own edits) so the user has a clear ` +
            `record of the task outcome.`
          );
        }

        const {
          heading,
          summary: sum,
          continuation,
          attachmentMarkdown,
        } = await finalizeEpicTaskExecution({
          ctx,
          epicAgentId: epic?.agentId,
          summary,
          status,
          failureReason,
          conversationCtx,
        });

        // Per-task pause flow: surface the summary file as a chat attachment
        // and explicitly tell the model to stop here. `continuation` is empty
        // when more tasks remain in the epic (no auto-continue), and carries
        // the PR-created / plan-awaiting-approval text only when the WHOLE
        // stage just finished — those messages still need to reach the user.
        const attachmentBlock = attachmentMarkdown
          ? `\n\n**Summary file (deliver to the user):** ${attachmentMarkdown}`
          : "";
        const pauseHint = continuation
          ? ""
          : `\n\n[System: Reply to the user with a brief progress update for ` +
            `this task and include the summary attachment markdown above ` +
            `verbatim. Do NOT call any more tools. Wait for the user to ` +
            `explicitly tell you to continue before starting the next task.]`;

        return `${heading}\n\n${sum}${attachmentBlock}${continuation}${pauseHint}`;
      } catch (err: any) {
        logger.error("CompleteEpicTask: failed", {
          error: err?.message,
          stack: err?.stack,
        });
        return `Error completing epic task: ${err?.message ?? String(err)}`;
      }
    },
    {
      name: "complete_epic_task",
      description:
        "Finalize the currently in-progress epic task after your sub-agents have all returned. " +
        "Captures the git diff, commits leftover changes (on completed), flips the task status, " +
        "and writes the per-task summary file. Auto-resolves the active epic + in-progress task — " +
        "no IDs needed. Required after EVERY `start_epic_task` invocation. After this returns, " +
        "the orchestrator pauses — the next task does NOT start until the user explicitly says " +
        "to continue.",
      schema: z.object({
        summary: z
          .string()
          .min(1)
          .describe(
            "Markdown summary aggregating what each sub-agent did + the overall outcome. " +
            "Persists to disk and is returned to the orchestrator turn so the user sees what " +
            "happened. Include per-slice file lists when the sub-agents reported them.",
          ),
        status: z
          .enum(["completed", "failed"])
          .describe(
            "Use 'completed' when all sub-agents finished and their work is acceptable. Use " +
            "'failed' when the slice work could not be reconciled (sub-agents conflicted, a " +
            "critical sub-agent errored, etc.) — you must pass `failureReason` in that case.",
          ),
        failureReason: z
          .string()
          .optional()
          .describe(
            "Required when status='failed'. Short explanation of what went wrong, used as " +
            "feedback for the next retry attempt.",
          ),
      }),
    },
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Codex-vendor epic-task lifecycle (slice 23)
// ═══════════════════════════════════════════════════════════════════════════════
//
// When the epic orchestrator runs on the OpenAI vendor, sub-agent dispatch
// (slice 20's Anthropic flow) does not apply — Codex's SDK has no native
// `Task()` parallelism, and spawning N concurrent Codex sessions against
// one repo would race on the git index. Codex's strength is sustained
// reasoning + tool use inside ONE session, so the codex-vendor flow is:
//
//   1. (Optional) `plan_epic_task` — read-only Codex run that produces a
//      Markdown plan. Lets the orchestrator scout before paying for the
//      write-side tokens, and gives the user an inspection point if the
//      task is consequential.
//   2. `start_epic_task_codex` — workspace-write Codex run that executes
//      the task end-to-end, optionally seeded with the plan from step 1.
//      Codex's internal tool loop handles all the file edits + commits.
//   3. `complete_epic_task` — shared lifecycle finalize (slice 20). Same
//      tool both vendors use; captures git diff, marks status, persists
//      summary file, appends EPIC_CONTINUATION marker.

const CODEX_PLAN_SYSTEM_PROMPT =
  "You are an engineering planner working in a git repository in read-only " +
  "mode. You CANNOT modify files or run shell commands — every Write/Edit/" +
  "shell call will be refused at the sandbox layer. Your job is to produce a " +
  "comprehensive, file-level execution plan for the task described below.\n\n" +
  "Output a single Markdown document with these sections (use exactly these " +
  "headings):\n\n" +
  "## Plan\n" +
  "Three to seven numbered steps the implementer should take, in order. Each " +
  "step names the concrete file(s) it touches.\n\n" +
  "## Files to modify\n" +
  "Bullet list. Each bullet is a file path + a one-line summary of what " +
  "changes there.\n\n" +
  "## Risks & edge cases\n" +
  "Bullets. Anything non-obvious — places where the change could break " +
  "neighbours, data migration concerns, tests that need updating, etc.\n\n" +
  "## Validation\n" +
  "How the implementer should verify the change works (commands, files to " +
  "check, etc.).\n\n" +
  "Use Read / Glob / Grep liberally to base the plan on the actual repo. " +
  "Do not propose files or behaviours that don't exist. The plan is the " +
  "ENTIRE output — no preamble, no summary at the top, no closing remarks.";

const CODEX_EXECUTE_SYSTEM_PROMPT_BASE =
  "You are an engineering agent executing one task in a multi-stage epic " +
  "workflow inside the repository's working directory — you may Read, Write, " +
  "Edit, run shell commands, and apply patches. The orchestrator has already " +
  "synced the stage's feature branch; commit your changes locally as you " +
  "finish logical units of work.\n\n" +
  "Constraints:\n" +
  "- Stay strictly within the task's scope. Do not refactor unrelated code, " +
  "rename files for cosmetics, or 'improve' code outside the task.\n" +
  "- Run any tests or type checks the project provides before declaring done.\n" +
  "- End your response with a `## Files changed` Markdown section listing " +
  "every file you created/edited/deleted with a one-line summary per file. " +
  "If you made no changes, write `- (none)`.";

interface ResolvedCodexAgentCredential {
  apiKey: string | null;
  authObject: Record<string, unknown> | null;
  modelSlug: string;
}

/**
 * Resolves the codex-vendor execution context for the calling orchestrator
 * agent: model slug + per-org credentials (auth_object preferred, api_key
 * fallback). Returns null when the agent isn't on a codex-vendor model OR
 * when neither credential row is configured.
 */
async function resolveCodexAgentCredential(
  agentId: string,
): Promise<ResolvedCodexAgentCredential | null> {
  const modelSlug = await resolveModelSlug(agentId);
  const vendor = await resolveOrgVendor(modelSlug, agentId);
  if (!vendor || vendor.vendorSlug !== "openai") return null;
  const authObject = await loadCodexAuthObjectForAgent(agentId);
  const apiKey = vendor.apiKey ?? null;
  if (!authObject && !apiKey) return null;
  return {
    apiKey: authObject ? null : apiKey,
    authObject,
    modelSlug,
  };
}

/**
 * Mirrors the rule the regular Codex SDK runner already uses
 * (`codexSdkRunner.ts:662-679`): an agent's `allow_sdk_bash` column gates
 * the sandbox mode for any Codex run on its behalf. TRUE → full shell
 * access (`danger-full-access`), FALSE → workspace-bounded
 * (`workspace-write`). Migration 126 flipped the column default to TRUE
 * for both vendors, so absence-of-row is treated as TRUE; admins opt OUT
 * for restricted agents.
 *
 * Runtime relevance: when the agent_service container can't host
 * bubblewrap (e.g. Docker without `seccomp:unconfined`, no
 * `kernel.unprivileged_userns_clone`), `workspace-write` fails every
 * shell + write inside Codex with `bwrap: No permissions to create a new
 * namespace`. `danger-full-access` skips bubblewrap entirely — the
 * container itself is the trust boundary — so trusted agents can still
 * execute. Picking the mode from the DB rather than hardcoding it makes
 * the deployment-level isolation choice explicit at the
 * agent-permissions layer instead of silently locking up at runtime.
 */
async function resolveCodexExecuteSandboxMode(
  agentId: string,
): Promise<"workspace-write" | "danger-full-access"> {
  try {
    const agentRow = await Agent.findByPk(agentId, {
      attributes: ["allowSdkBash"],
    });
    const allowBash = agentRow?.allowSdkBash !== false;
    return allowBash ? "danger-full-access" : "workspace-write";
  } catch (err: any) {
    logger.warn(
      "resolveCodexExecuteSandboxMode: agent lookup failed — defaulting to workspace-write",
      { agentId, error: err?.message },
    );
    return "workspace-write";
  }
}

/**
 * Resolves the active epic + its primary repo's localPath. Shared by both
 * `plan_epic_task` and `start_epic_task_codex` so they pick the same cwd
 * the orchestrator's sub-agent dispatch path uses.
 */
async function resolveActiveEpicRepoCwd(): Promise<{
  epic: EpicTask;
  cwd: string;
  next: AgentTask;
}> {
  const epic = await resolveActiveEpic();
  const next = await resolveNextRetryableTask(epic.id);
  if (!next) {
    throw new Error(
      `No tasks are ready to execute on epic "${epic.title}" (status: ${epic.status}).`,
    );
  }
  const withRepos = await EpicTask.findByPk(epic.id, {
    include: [{ model: Repository, as: "repositories" }],
  });
  const repos = ((withRepos as any)?.repositories ?? []) as Repository[];
  const repo = repos.find((r) => r.localPath);
  if (!repo?.localPath) {
    throw new Error(
      `Cannot run codex tool — no repository has a localPath configured for epic "${epic.title}".`,
    );
  }
  return { epic, cwd: repo.localPath, next };
}

/**
 * Optional read-only scout. Runs Codex on the next ready task with
 * `sandboxMode: "read-only"` and a planning prompt, returns the produced
 * Markdown plan. Does NOT mutate task state, run preExecutionSync, or
 * create an execution row — the orchestrator can call this at will to
 * scout before deciding whether to commit to execution.
 *
 * Use case: surface the plan to the user for approval on consequential
 * tasks (migrations, anything user-visible) before paying for write-side
 * tokens. Trivial edits can skip planning entirely and go straight to
 * `start_epic_task_codex`.
 */
export function PlanEpicTaskCodexTool(callerAgentId: string) {
  return tool(
    async () => {
      try {
        const cred = await resolveCodexAgentCredential(callerAgentId);
        if (!cred) {
          return (
            `Error: \`plan_epic_task\` is only available when the orchestrator ` +
            `runs on an OpenAI / Codex-vendor model AND the org has uploaded ` +
            `a Codex credential (api_key or auth.json). Verify the model + ` +
            `the credentials in Admin → Vendor API Keys.`
          );
        }

        const { epic, cwd, next } = await resolveActiveEpicRepoCwd();

        const userPrompt =
          `Task title: ${next.title}\n\n` +
          `Task description:\n${next.description ?? "(no description)"}\n\n` +
          `Epic context: ${epic.title}\n\n` +
          `Produce the plan per the rules in your system prompt. Read the ` +
          `repo, follow the headings exactly, and stay within the scope of ` +
          `THIS task only.`;

        const result = await runCodexInRepo({
          apiKey: cred.apiKey,
          authObject: cred.authObject,
          model: cred.modelSlug,
          systemPrompt: CODEX_PLAN_SYSTEM_PROMPT,
          userPrompt,
          cwd,
          sandboxMode: "read-only",
          observeName: "codex_plan_epic_task",
        });

        const plan = (result.finalText ?? "").trim();
        if (!plan) {
          return (
            `Codex returned an empty plan. The model halted without ` +
            `producing output — retry, or try a higher-capacity model. ` +
            `\`start_epic_task_codex\` requires a plan and will refuse to ` +
            `run without one.`
          );
        }

        return (
          `# Plan for next task: ${next.title}\n\n` +
          `Repository cwd: \`${cwd}\` (read-only scan completed)\n\n` +
          `${plan}\n\n` +
          `---\n` +
          `Pass this plan VERBATIM to \`start_epic_task_codex\` via the ` +
          `\`plan\` parameter to execute. The execute step runs the same ` +
          `model with workspace-write sandbox to apply the changes.`
        );
      } catch (err: any) {
        logger.error("PlanEpicTask: failed", {
          error: err?.message,
          stack: err?.stack,
        });
        return `Error producing plan: ${err?.message ?? String(err)}`;
      }
    },
    {
      name: "plan_epic_task",
      description:
        "Required read-only planning pass for the next ready epic task. Runs Codex against the " +
        "repo with the sandbox pinned to read-only and asks for a structured Markdown plan " +
        "(steps, files to modify, risks, validation). Does NOT mark the task in_progress or " +
        "modify any files — pure inspection.\n\n" +
        "**Call ORDER is fixed:** call this FIRST, then pass its returned Markdown into " +
        "`start_epic_task_codex` via the `plan` parameter. `start_epic_task_codex` will refuse " +
        "to run without a plan — there is no \"skip planning\" path on the Codex flow.",
      schema: z.object({}),
    },
  );
}

/**
 * Begin work on the next ready task via the Codex SDK. After fast preflight
 * (sync branch, mark in_progress, snapshot HEAD, execution row, session folder),
 * returns immediately while Codex runs in a detached continuation so MCP tool
 * timeouts cannot strand in-flight work. The server auto-finalizes when Codex
 * finishes (same steps as `complete_epic_task`) and enqueues continuation.
 *
 * Sandbox mode follows `resolveCodexExecuteSandboxMode` (allow_sdk_bash).
 */
export function StartEpicTaskCodexTool(
  callerAgentId: string,
  sessionCtx?: {
    threadId: string;
    sessionWorkspacePath: string | null;
    userId?: number;
    groupId?: string | null;
    singleChatId?: string | null;
  },
) {
  return tool(
    async (input) => {
      try {
        const cred = await resolveCodexAgentCredential(callerAgentId);
        if (!cred) {
          return (
            `Error: \`start_epic_task_codex\` is only available when the ` +
            `orchestrator runs on an OpenAI / Codex-vendor model AND the org ` +
            `has uploaded a Codex credential. Use \`start_epic_task\` if the ` +
            `orchestrator is on Anthropic instead.`
          );
        }

        const epic = await resolveActiveEpic();
        let next = await resolveNextRetryableTask(epic.id);
        if (!next) {
          if (await epicHasDetachedCodexInflight(epic.id)) {
            return (
              `Codex is already executing for the current in-progress task (detached server-side — ` +
              `an MCP tool timeout does not stop it). **Do not call \`start_epic_task_codex\` again.** ` +
              `Poll \`get_epic_status\` about once per minute until that task shows \`completed\` or ` +
              `\`failed\`. The server finalizes automatically when Codex finishes — you must **not** ` +
              `call \`complete_epic_task\` for this path.`
            );
          }
          throw new Error(
            `No tasks are ready to execute on epic "${epic.title}" (status: ${epic.status}).`,
          );
        }

        const inflightExec = await TaskExecution.findOne({
          where: { agentTaskId: next.id, status: "running" as TaskExecutionStatus },
          order: [["attemptNumber", "DESC"]],
        });
        const inflightMeta = (inflightExec?.metadata ?? {}) as Record<string, unknown>;
        if (inflightExec && inflightMeta.codex_run_in_flight === true) {
          return (
            `Codex is already running for task "${next.title}" (\`task_executions\` still marked ` +
            `in-flight). **Do not start again** — poll \`get_epic_status\` ~every minute until the ` +
            `task reaches \`completed\` or \`failed\`.`
          );
        }

        const withRepos = await EpicTask.findByPk(epic.id, {
          include: [{ model: Repository, as: "repositories" }],
        });
        const repos = ((withRepos as any)?.repositories ?? []) as Repository[];
        const repo = repos.find((r) => r.localPath);
        if (!repo?.localPath) {
          throw new Error(
            `Cannot run codex tool — no repository has a localPath configured for epic "${epic.title}".`,
          );
        }
        const repoCwd = repo.localPath;

        const epicFull = await EpicTask.findByPk(epic.id, {
          attributes: ["id", "agentId", "userId"],
        });

        const stage = await TaskStage.findByPk(next.taskStageId);
        const stageKind = stage?.kind ?? "code_change";

        const sessionWorkspacePath = sessionCtx?.sessionWorkspacePath ?? null;
        if (sessionWorkspacePath) {
          await ensureSessionWorkspace(sessionWorkspacePath);
        }

        const isPlanStage = stageKind === "plan";
        const cwd =
          isPlanStage && sessionWorkspacePath ? sessionWorkspacePath : repoCwd;

        await preExecutionSync(epic.id, next.id);
        await next.update({
          status: "in_progress" as AgentTaskStatus,
          startedAt: next.startedAt ?? new Date(),
          completedAt: null,
        });

        let preRunSha: string | null = null;
        try {
          preRunSha = gitAsAgent(repoCwd, ["rev-parse", "HEAD"]) || null;
        } catch (err: any) {
          logger.warn("StartEpicTaskCodex: failed to snapshot HEAD (non-fatal)", {
            taskId: next.id,
            cwd: repoCwd,
            error: err?.message,
          });
        }

        const plan = input.plan.trim();

        const execution = await startExecution(next.id, {
          prompt: next.description ?? next.title,
          metadata: {
            ...(preRunSha ? { pre_run_sha: preRunSha } : {}),
            executor: "codex",
            stage_kind: stageKind,
            cwd,
            ...(sessionWorkspacePath ? { session_workspace_path: sessionWorkspacePath } : {}),
            plan,
            codex_run_in_flight: true,
          },
        });

        const planAddendum =
          `## Pre-approved plan to follow\n` +
          `An earlier read-only scout produced this plan. Treat it as the ` +
          `blueprint for execution — deviate only if you find the repo ` +
          `state contradicts an assumption in the plan, and explicitly note ` +
          `the deviation in your final summary.\n\n` +
          plan;

        const writeBoundaryAddendum = isPlanStage
          ? `## Write boundary (plan stage)\n` +
            `This is a PLAN stage — research-only, no code changes. Your cwd ` +
            `is the per-thread session workspace, not the product repo:\n` +
            `- **Write target (cwd):** \`${cwd}\` — put every deliverable ` +
            `(\`.md\` markdown reports, notes, structured findings) here. ` +
            `Use relative paths or this absolute path — both resolve to the ` +
            `same place.\n` +
            `- **Read target (repo):** \`${repoCwd}\` — read the codebase ` +
            `using ABSOLUTE paths via \`Read\`/\`Glob\`/\`Grep\`. Do NOT ` +
            `modify, create, or delete any file inside \`${repoCwd}\`. The ` +
            `repo is read-only for this stage by convention.\n` +
            `- Do NOT run \`git\`, \`npm\`, build, or test commands — this ` +
            `stage produces a written deliverable, not a code change.`
          : `## Write boundary (code-change stage)\n` +
            `Your cwd is the product repo:\n` +
            `- **Write target (cwd):** \`${cwd}\` — apply code edits here ` +
            `and commit logical units as you go.` +
            (sessionWorkspacePath
              ? `\n- **Optional scratch / notes target:** absolute path ` +
                `\`${sessionWorkspacePath}\` is the per-thread session folder ` +
                `— if you want to drop intermediate research notes, design ` +
                `sketches, or anything that is NOT part of the code change, ` +
                `write \`.md\`/\`.txt\` files there with absolute paths. ` +
                `Anything you write inside cwd will end up in the PR; ` +
                `anything you write to the session folder will not.`
              : "");

        const systemPrompt =
          `${CODEX_EXECUTE_SYSTEM_PROMPT_BASE}\n\n` +
          `${planAddendum}\n\n` +
          writeBoundaryAddendum;

        const userPrompt = isPlanStage
          ? `Task title: ${next.title}\n\n` +
            `Task description:\n${next.description ?? "(no description)"}\n\n` +
            `Epic context: ${epic.title}\n\n` +
            `Repository to inspect (read-only): \`${repoCwd}\`\n\n` +
            `Produce your deliverable as a Markdown file inside the session ` +
            `workspace (your cwd). Use a descriptive filename. End your ` +
            `final response with a \`## Files changed\` section listing ` +
            `every file you wrote.`
          : `Task title: ${next.title}\n\n` +
            `Task description:\n${next.description ?? "(no description)"}\n\n` +
            `Epic context: ${epic.title}\n\n` +
            `Execute the task end-to-end. Make the file edits, run any ` +
            `relevant tests/checks, and commit logical units locally as you ` +
            `go. Finish with the \`## Files changed\` summary.`;

        const sandboxMode = await resolveCodexExecuteSandboxMode(callerAgentId);

        const conversationCtxFinalize =
          sessionCtx?.threadId && sessionCtx?.userId !== undefined
            ? { threadId: sessionCtx.threadId, userId: sessionCtx.userId }
            : undefined;

        const taskIdForBg = next.id;
        const executionIdForBg = execution.id;
        const epicIdForBg = epic.id;

        void Promise.resolve().then(() =>
          (async () => {
            try {
              const result = await runCodexInRepo({
                apiKey: cred.apiKey,
                authObject: cred.authObject,
                model: cred.modelSlug,
                systemPrompt,
                userPrompt,
                cwd,
                sandboxMode,
                observeName: "codex_start_epic_task",
              });

              const finalText = (result.finalText ?? "").trim();
              const summary = finalText || "(Codex finished with no final text.)";

              const execReload = await TaskExecution.findByPk(executionIdForBg);
              const taskReload = await AgentTask.findByPk(taskIdForBg);
              if (!execReload || !taskReload) {
                logger.error("StartEpicTaskCodex: detached finalize missing task/execution row", {
                  executionId: executionIdForBg,
                  taskId: taskIdForBg,
                });
                return;
              }

              const fin = await finalizeEpicTaskExecution({
                ctx: {
                  task: taskReload,
                  execution: execReload,
                  epicId: epicIdForBg,
                  cwd: repoCwd,
                  preRunSha,
                },
                epicAgentId: epicFull?.agentId,
                summary,
                status: "completed",
                failureReason: null,
                conversationCtx: conversationCtxFinalize,
                executionMetadataPatch: { codex_run_in_flight: false },
              });

              if (
                epicFull?.userId != null &&
                epicFull.agentId &&
                sessionCtx?.userId !== undefined
              ) {
                await enqueueEpicPostCodexFinalizeTurn({
                  epicUserId: epicFull.userId,
                  agentId: epicFull.agentId,
                  groupId: sessionCtx.groupId ?? null,
                  singleChatId: sessionCtx.singleChatId ?? null,
                  heading: fin.heading,
                  summary: fin.summary,
                  attachmentMarkdown: fin.attachmentMarkdown,
                  continuationSuffix: fin.continuation,
                });
              }
            } catch (err: any) {
              logger.error("StartEpicTaskCodex: detached codex run failed", {
                taskId: taskIdForBg,
                executionId: executionIdForBg,
                error: err?.message,
                stack: err?.stack,
              });
              try {
                const execReload = await TaskExecution.findByPk(executionIdForBg);
                const taskReload = await AgentTask.findByPk(taskIdForBg);
                if (!execReload || !taskReload) return;

                if (execReload.status !== "running") {
                  logger.warn("StartEpicTaskCodex: execution already finalized after error", {
                    executionId: executionIdForBg,
                  });
                  return;
                }

                const failSummary =
                  `Codex execution failed: ${err?.message ?? String(err)}`;
                const finFail = await finalizeEpicTaskExecution({
                  ctx: {
                    task: taskReload,
                    execution: execReload,
                    epicId: epicIdForBg,
                    cwd: repoCwd,
                    preRunSha,
                  },
                  epicAgentId: epicFull?.agentId,
                  summary: failSummary,
                  status: "failed",
                  failureReason: err?.message ?? String(err),
                  conversationCtx: conversationCtxFinalize,
                  executionMetadataPatch: { codex_run_in_flight: false },
                });

                if (
                  epicFull?.userId != null &&
                  epicFull.agentId &&
                  sessionCtx?.userId !== undefined
                ) {
                  await enqueueEpicPostCodexFinalizeTurn({
                    epicUserId: epicFull.userId,
                    agentId: epicFull.agentId,
                    groupId: sessionCtx.groupId ?? null,
                    singleChatId: sessionCtx.singleChatId ?? null,
                    heading: finFail.heading,
                    summary: finFail.summary,
                    attachmentMarkdown: finFail.attachmentMarkdown,
                    continuationSuffix: finFail.continuation,
                  });
                }
              } catch (finalizeErr: any) {
                logger.error("StartEpicTaskCodex: failed to finalize after codex error", {
                  taskId: taskIdForBg,
                  error: finalizeErr?.message,
                });
              }
            }
          })(),
        );

        const stageLabel = stage
          ? `Stage "${stage.title}" (${stage.kind})`
          : `Stage (kind: ${stageKind})`;

        return (
          `# Codex execution started (detached): ${next.title}\n\n` +
          `**${stageLabel}**\n\n` +
          `Working directory: \`${cwd}\`\n` +
          (isPlanStage
            ? `Read target (repo): \`${repoCwd}\`\n`
            : sessionWorkspacePath
              ? `Scratch / notes folder: \`${sessionWorkspacePath}\`\n`
              : "") +
          `Branch base SHA: ${preRunSha ?? "(unknown)"}\n` +
          `Sandbox mode: \`${sandboxMode}\`\n` +
          `Execution ID: \`${execution.id}\`\n\n` +
          `Codex is running **server-side** outside this tool call's lifetime — MCP timeouts will ` +
          `not cancel it. **End your turn now**: reply to the user with one short progress line ` +
          `("Started task X via Codex; will update when it finishes.") and **do not call any more ` +
          `tools**. The system is event-driven — when Codex's session terminates, the server ` +
          `auto-finalizes (git diff, execution row, task status, per-task summary file) and ` +
          `enqueues a follow-up turn that will deliver the summary + chat attachment to the user. ` +
          `Do **not** call \`complete_epic_task\` (the server handles that for the Codex path), ` +
          `and do **not** poll \`get_epic_status\` in a loop — that just burns tool rounds against ` +
          `the per-turn cap while Codex runs in the background. If the user explicitly asks for a ` +
          `mid-run status check later, calling \`get_epic_status\` once is fine, but never as a ` +
          `wait-for-completion mechanism.`
        );
      } catch (err: any) {
        logger.error("StartEpicTaskCodex: failed", {
          error: err?.message,
          stack: err?.stack,
        });
        return `Error executing task via codex: ${err?.message ?? String(err)}`;
      }
    },
    {
      name: "start_epic_task_codex",
      description:
        "Execute the next ready epic task via the Codex SDK. Auto-resolves the epic + task. " +
        "After fast setup, starts ONE Codex workspace-write session **in the background** and " +
        "returns immediately so MCP client timeouts do not abort long runs.\n\n" +
        "**Call ORDER:** first `plan_epic_task`, then pass its Markdown into `plan`. Required.\n\n" +
        "**After this returns:** end your turn with a brief progress message to the user and do " +
        "NOT call any more tools. The system wakes you automatically with a follow-up turn when " +
        "Codex finishes — that follow-up carries the summary + chat attachment. Do **not** call " +
        "`complete_epic_task` (the server finalizes automatically), and do **not** poll " +
        "`get_epic_status` waiting for completion — Codex runs can take minutes and the per-turn " +
        "tool cap will trip first.\n\n" +
        "**Codex-vendor only — use `start_epic_task` on Anthropic.**",
      schema: z.object({
        plan: z
          .string()
          .min(1)
          .describe(
            "Required. Markdown plan produced by a prior `plan_epic_task` call (Codex's read-only " +
            "planning pass for this same task). Codex will treat it as the blueprint for execution. " +
            "Do not pass null or an empty string — call `plan_epic_task` first if you don't have a plan yet.",
          ),
      }),
    },
  );
}

/**
 * Tool to view the current status of an epic and all its stages/tasks.
 */
export function GetEpicStatusTool() {
  return tool(
    async () => {
      try {
        // Auto-resolve the active epic — singleton invariant makes this unambiguous.
        const active = await resolveActiveEpic();
        const epic = await getEpic(active.id, {
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
          // Tag plan stages so the user/orchestrator sees they will not
          // produce a PR. Code-change stages stay un-tagged (default).
          const kindTag = stage.kind === "plan" ? " (plan — no PR)" : "";
          summary += `Stage "${stage.title}"${kindTag} — ${stage.status}${prInfo}\n`;

          for (const task of tasks) {
            const executions = task.executions ?? [];
            const lastExec = executions[executions.length - 1];
            const execInfo = lastExec
              ? ` [attempt #${lastExec.attemptNumber}, ${lastExec.status}]`
              : "";
            summary += `  ${task.status === "completed" ? "+" : task.status === "failed" ? "x" : "o"} "${task.title}" — ${task.status}${execInfo}\n`;
          }

          // Stage-level diff stat — treats the whole stage as one unit of
          // work from the user's perspective. Anchored at the stage's
          // captured base SHA, so it stays accurate even as the default
          // branch moves on. We only include the stat (not the full diff)
          // so this tool's output stays compact; use review_task_diff or
          // the PR itself for the full diff.
          if (stage.baseCommitSha) {
            try {
              const stageDiff = await captureStageDiff(stage);
              if (stageDiff && stageDiff.diffStat) {
                const statLines = stageDiff.diffStat.split("\n").slice(-1)[0] || "";
                summary += `  Stage diff: ${statLines}\n`;
              } else if (stageDiff) {
                summary += `  Stage diff: (no changes yet)\n`;
              }
            } catch {
              // Non-fatal — stage diff is a convenience.
            }
          }
          summary += "\n";
        }

        const readyTasks = await getReadyTasks(epic.id);
        if (readyTasks.length > 0) {
          summary += `Ready to execute: ${readyTasks.map((t) => `"${t.title}"`).join(", ")}\n`;
        }

        // Flag stages that need attention. Plan stages park at `pr_pending`
        // for user review even though they don't produce a PR — surface that
        // explicitly so the orchestrator knows to ask for approval rather
        // than chasing a missing PR.
        for (const stage of stages) {
          if (stage.kind === "plan") {
            if (stage.status === "pr_pending") {
              summary +=
                `\n⏳ Plan stage "${stage.title}" is awaiting the user's review and approval. ` +
                `No PR — call \`approve_stage\` with the user's verbatim approval quote to continue.\n`;
            }
            continue;
          }
          if (stage.status === "pr_pending" && !stage.prNumber) {
            summary +=
              `\n⚠ Stage "${stage.title}" tasks are done but no PR was created yet. ` +
              `PR creation should have happened automatically. If it failed, run: ` +
              `\`git push origin HEAD\` then \`gh pr create\`, then call update_stage_pr.\n`;
          } else if (stage.status === "pr_pending" && stage.prNumber) {
            summary +=
              `\n⏳ Stage "${stage.title}" is waiting for PR #${stage.prNumber} to be approved. ` +
              `The next stage will start automatically once the PR is approved.\n`;
          } else if ((stage.status === "pr_pending" || stage.status === "in_progress") && stage.prStatus === "changes_requested") {
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
        "Get the current status of the active epic and all its stages/tasks. " +
        "Use this to check progress, see which tasks are completed, failed, or ready to execute. " +
        "No arguments — the orchestrator is a system-wide singleton so the active epic is unambiguous.",
      schema: z.object({}),
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
 * creating the pull request.
 */
export function UpdateStagePrTool() {
  return tool(
    async (input) => {
      try {
        // Auto-resolve the unique pr_pending stage — this tool is called
        // immediately after `gh pr create` on the stage whose tasks just
        // finished, which by invariant is the only pr_pending stage.
        const { stage } = await resolveActivePrPendingStage();

        await stage.update({
          prUrl: input.prUrl,
          prNumber: input.prNumber,
          prStatus: (input.prStatus ?? "open") as PrStatus,
          repositoryId: input.repositoryId ?? stage.repositoryId,
        });

        logger.info("Stage PR info updated", {
          stageId: stage.id,
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
        "Record the pull request URL and number on the stage currently awaiting review. " +
        "Targets the unique pr_pending stage of the active epic (auto-resolved). " +
        "This links the stage to the GitHub PR so that the approval webhook can automatically " +
        "unblock the next stage. Call this immediately after manually creating a PR with `gh pr create` " +
        "(only needed when automatic PR creation failed).",
      schema: z.object({
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

        // Auto-resolve the unique pr_pending stage — the invariant guarantees
        // that the stage currently awaiting approval is the last one whose
        // tasks were executed.
        const { stage } = await resolveActivePrPendingStage();

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
        "DESTRUCTIVE — bypasses the PR review webhook and marks the currently-pending stage's PR as approved, " +
        "triggering the next stage to start executing. Targets the unique stage awaiting review (auto-resolved). " +
        "USE ONLY when ALL of the following are true: " +
        "(1) the user has stated in THIS conversation that they manually reviewed and approved the PR, " +
        "(2) the user has explicitly instructed you to proceed without waiting for the automatic approval webhook, " +
        "(3) you can quote the exact user message that granted this authorization. " +
        "NEVER call this tool on your own initiative. NEVER use it to 'keep things moving' or to retry a failed webhook. " +
        "If the user has not given explicit, unambiguous consent, refuse and ask them to confirm first. " +
        "The 'userConfirmationQuote' field is mandatory and must contain the verbatim user authorization.",
      schema: z.object({
        userConfirmationQuote: z.string().min(10).describe(
          "Verbatim quote of the user's message authorizing the bypass. " +
          "Must be the actual text the user wrote in this conversation — not a paraphrase. " +
          "Example: 'I already approved the PR on GitHub, please continue with the next stage'.",
        ),
      }),
    },
  );
}

// ─── Approve Stage (manual, no PR required) ─────────────────────────────────

export function ApproveStageTool() {
  return tool(
    async (input) => {
      try {
        const quote = input.userConfirmationQuote?.trim();
        if (!quote || quote.length < 5) {
          return (
            `Error: approve_stage requires 'userConfirmationQuote' — a verbatim ` +
            `quote of the user's explicit authorization to mark this stage as completed. ` +
            `This tool must NEVER be called without clear user consent in the conversation.`
          );
        }

        // Auto-resolve the unique pr_pending stage of the active epic.
        const { stage } = await resolveActivePrPendingStage();

        // If the stage has a PR, route through handlePrApproval for consistency
        if (stage.repositoryId && stage.prNumber) {
          const { EpicTaskService } = await import("../services/epicTask.service");
          const service = new EpicTaskService();
          const result = await service.handlePrApproval(stage.repositoryId, stage.prNumber);

          logger.info("Stage approved manually via chat (has PR)", {
            stageId: stage.id,
            prNumber: stage.prNumber,
            userQuote: quote,
          });

          let summary =
            `Stage "${stage.title}" has been approved and marked as completed.\n` +
            `Authorization: "${quote}"\n\n`;

          if (result.epicCompleted) {
            summary += `All stages are now complete — the epic is finished!`;
          } else if (result.readyTasks.length > 0) {
            summary += `${result.readyTasks.length} task(s) in the next stage are now ready and will be executed automatically.`;
          } else {
            summary += `No new tasks were unblocked.`;
          }
          return summary;
        }

        // No PR — directly complete the stage
        await stage.update({
          status: "completed" as TaskStageStatus,
          completedAt: new Date(),
        });

        // Unblock next-stage tasks AND propagate that stage's derived status
        // (pending → in_progress) in one call, so the orchestrator's next
        // turn doesn't have to start a task before the UI catches up.
        const newlyReadyIds = await advanceNextStageReadyTasks(stage.epicTaskId);

        // Check if epic is fully done
        const { EpicTaskService } = await import("../services/epicTask.service");
        const service = new EpicTaskService();
        const epicCompleted = await (service as any).checkAndFinalizeEpic(stage.epicTaskId);

        logger.info("Stage approved manually via chat (no PR)", {
          stageId: stage.id,
          userQuote: quote,
          newlyReadyCount: newlyReadyIds.length,
        });

        let summary =
          `Stage "${stage.title}" has been approved and marked as completed.\n` +
          `Authorization: "${quote}"\n\n`;

        if (epicCompleted) {
          summary += `All stages are now complete — the epic is finished!`;
        } else if (newlyReadyIds.length > 0) {
          summary += `${newlyReadyIds.length} task(s) in the next stage are now ready and will be executed automatically.`;
        } else {
          summary += `No new tasks were unblocked.`;
        }
        return summary;
      } catch (err: any) {
        logger.error("ApproveStageTool: failed", { error: err.message });
        return `Error approving stage: ${err.message}`;
      }
    },
    {
      name: "approve_stage",
      description:
        "Marks the stage currently awaiting review as completed after the user explicitly approves it. " +
        "Targets the unique pr_pending stage of the active epic (auto-resolved). " +
        "Use this when the user says they've reviewed the changes or the PR and want to proceed to the next stage. " +
        "This transitions the stage from 'pr_pending' to 'completed', unblocking the next stage's tasks. " +
        "REQUIRES explicit user consent — never call without the user clearly stating approval. " +
        "The 'userConfirmationQuote' must contain the verbatim user message.",
      schema: z.object({
        userConfirmationQuote: z.string().min(5).describe(
          "Verbatim quote of the user's message authorizing the stage completion. " +
          "Must be the actual text the user wrote — not a paraphrase.",
        ),
      }),
    },
  );
}

// ─── Cancel Active Epic ─────────────────────────────────────────────────────

/**
 * Tool for the orchestrator to cancel the currently active epic.
 * Marks the epic and all of its non-terminal stages/tasks as `cancelled`,
 * freeing the singleton slot so a new epic can be created.
 */
export function CancelEpicTool() {
  return tool(
    async (input) => {
      try {
        const quote = input.userConfirmationQuote?.trim();
        if (!quote || quote.length < 10) {
          return (
            `Error: cancel_epic requires 'userConfirmationQuote' — a verbatim ` +
            `quote of the user's explicit authorization to cancel the active epic. ` +
            `This tool must NEVER be called without clear user consent in the conversation.`
          );
        }

        // Auto-resolve the active epic — singleton invariant.
        const epic = await resolveActiveEpic();

        const fullEpic = await getEpic(epic.id, {
          includeStages: true,
          includeTasks: true,
        });
        const stages = (((fullEpic as any)?.stages ?? []) as any[]);

        const terminalStageStatuses: TaskStageStatus[] = ["completed", "cancelled", "failed"];
        const terminalTaskStatuses: AgentTaskStatus[] = ["completed", "cancelled", "failed"];

        const stageIdsToCancel: string[] = [];
        const taskIdsToCancel: string[] = [];
        let runningTaskCount = 0;

        for (const stage of stages) {
          if (!terminalStageStatuses.includes(stage.status as TaskStageStatus)) {
            stageIdsToCancel.push(stage.id);
          }
          const tasks = (stage.tasks ?? []) as AgentTask[];
          for (const task of tasks) {
            if (task.status === ("in_progress" as AgentTaskStatus)) runningTaskCount++;
            if (!terminalTaskStatuses.includes(task.status as AgentTaskStatus)) {
              taskIdsToCancel.push(task.id);
            }
          }
        }

        if (taskIdsToCancel.length > 0) {
          await AgentTask.update(
            { status: "cancelled" as AgentTaskStatus },
            { where: { id: taskIdsToCancel } },
          );
        }
        if (stageIdsToCancel.length > 0) {
          await TaskStage.update(
            { status: "cancelled" as TaskStageStatus, completedAt: new Date() },
            { where: { id: stageIdsToCancel } },
          );
        }

        const cancelledAt = new Date();
        const existingMeta = (epic.metadata ?? {}) as Record<string, unknown>;
        await epic.update({
          status: "cancelled",
          completedAt: cancelledAt,
          metadata: {
            ...existingMeta,
            cancelledAt: cancelledAt.toISOString(),
            cancellationReason: input.reason ?? null,
            cancellationAuthorization: quote,
          },
        });

        logger.warn("Epic cancelled by orchestrator", {
          epicId: epic.id,
          epicTitle: epic.title,
          userQuote: quote,
          reason: input.reason ?? null,
          cancelledStageCount: stageIdsToCancel.length,
          cancelledTaskCount: taskIdsToCancel.length,
          runningTaskCount,
        });

        let summary =
          `Epic "${epic.title}" (ID: ${epic.id}) has been cancelled.\n` +
          `Authorization: "${quote}"\n` +
          (input.reason ? `Reason: ${input.reason}\n` : "") +
          `\nCancelled ${stageIdsToCancel.length} stage(s) and ${taskIdsToCancel.length} task(s).\n`;

        if (runningTaskCount > 0) {
          summary +=
            `\n⚠ ${runningTaskCount} task(s) were in_progress at cancellation time. ` +
            `Any Claude CLI process that was already running will finish in the background, ` +
            `but its results will no longer drive the epic forward.\n`;
        }

        summary +=
          `\nThe singleton slot is now free — a new epic can be created with create_epic_plan.`;

        return summary;
      } catch (err: any) {
        logger.error("CancelEpicTool: failed", { error: err.message });
        return `Error cancelling epic: ${err.message}`;
      }
    },
    {
      name: "cancel_epic",
      description:
        "DESTRUCTIVE — cancels the currently active epic. Marks the epic and all non-terminal stages/tasks " +
        "as 'cancelled', freeing the system-wide singleton slot so a new epic can be created. " +
        "Targets the active epic (auto-resolved — no IDs needed). " +
        "USE ONLY when the user has explicitly asked to stop, abort, or cancel the epic in THIS conversation. " +
        "NEVER call this tool on your own initiative to 'recover' from errors or skip stuck tasks — " +
        "prefer request_stage_changes or retry flows instead. " +
        "The 'userConfirmationQuote' field is mandatory and must contain the verbatim user authorization.",
      schema: z.object({
        userConfirmationQuote: z.string().min(10).describe(
          "Verbatim quote of the user's message authorizing the cancellation. " +
          "Must be the actual text the user wrote in this conversation — not a paraphrase. " +
          "Example: 'stop the current epic' or 'cancel this epic, I want to start over'.",
        ),
        reason: z.string().optional().describe(
          "Optional short reason explaining why the epic is being cancelled. " +
          "Stored on the epic's metadata for audit purposes.",
        ),
      }),
    },
  );
}

// ─── Request Changes on a Stage (chat-based, no webhook needed) ─────────────

export function RequestStageChangesTool() {
  return tool(
    async (input) => {
      try {
        // Auto-resolve: the unique pr_pending stage of the active epic.
        // Throws loudly if there's no active epic, or no stage in pr_pending,
        // or more than one (invariant violation) — so the model gets an
        // actionable error instead of hallucinating a stageId.
        const { stage } = await resolveActivePrPendingStage();

        const tasks = (stage as any).tasks as AgentTask[];
        const completedTasks = tasks
          .filter((t) => t.status === "completed")
          .sort((a, b) => a.sortOrder - b.sortOrder);
        if (completedTasks.length === 0) {
          return `Error: No completed tasks found in stage "${stage.title}" to retry.`;
        }

        const feedback = input.feedback;

        // Sequential-within-stage rule (also applies to retries): only the
        // lowest-sortOrder completed task flips back to `ready`; the rest go
        // back to `pending` and are promoted one-by-one by
        // `advanceNextTaskInStage` as each retry task completes.
        const retryTaskIds: string[] = [];
        for (let i = 0; i < completedTasks.length; i++) {
          const task = completedTasks[i];
          const lastExec = await TaskExecution.findOne({
            where: { agentTaskId: task.id },
            order: [["attempt_number", "DESC"]],
          });
          if (lastExec) {
            await lastExec.update({ feedback });
          }

          await task.update({
            status: (i === 0 ? "ready" : "pending") as AgentTaskStatus,
            completedAt: null,
          });
          retryTaskIds.push(task.id);
        }

        // Reset stage back to in_progress
        await stage.update({
          status: "in_progress" as TaskStageStatus,
          completedAt: null,
          prStatus: stage.prNumber ? "changes_requested" as PrStatus : stage.prStatus,
        });

        logger.info("Stage changes requested via chat", {
          stageId: stage.id,
          epicTaskId: stage.epicTaskId,
          retryTaskIds,
        });

        return (
          `Stage "${stage.title}" has been reset to in_progress. ` +
          `${retryTaskIds.length} task(s) are now ready for retry.\n\n` +
          `Call execute_epic_task with mode="retry" to continue. ` +
          `Feedback has been stored on each task's latest execution and will be loaded automatically; ` +
          `the previous CLI session will be resumed so full context is preserved.\n\n` +
          `Feedback: "${feedback}"`
        );
      } catch (err: any) {
        logger.error("RequestStageChangesTool: failed", { error: err.message });
        return `Error requesting stage changes: ${err.message}`;
      }
    },
    {
      name: "request_stage_changes",
      description:
        "Resets the stage currently awaiting review (pr_pending) back to in_progress so its tasks can be retried " +
        "with feedback. Use this when the user reviews the stage's output or PR and wants changes — instead of " +
        "approving.\n\n" +
        "No stageId needed — the tool auto-resolves the unique pr_pending stage of the active epic. " +
        "After calling this, call execute_epic_task with mode='retry' (no args needed — feedback is loaded from the " +
        "stored execution, and the retry resumes the previous CLI session for full context).",
      schema: z.object({
        feedback: z.string().min(5).describe(
          "Detailed feedback explaining what needs to be fixed. " +
          "Stored on each task's execution row and passed to the CLI on retry.",
        ),
      }),
    },
  );
}

// ─── Search past epic tasks by date ─────────────────────────────────────────

/**
 * General-purpose lookup of past epics by creation-date window. Returns the
 * full epic description (untruncated) so the result is useful for multiple
 * downstream paths:
 *   - "what did we work on last Tuesday?" → tell the user, optionally drill
 *     into the structure via `get_epic_task_stages_and_tasks` and fan out
 *     summaries via `send_file_to_user`.
 *   - "create a new epic similar to the StocksScanner one we did last week"
 *     → pull that epic's description and reuse it / reference it inside
 *     `create_epic_plan` for the new epic.
 *   - "remind me what was the scope of the auth refactor epic" → answer
 *     directly from the description, no follow-up tool call needed.
 *
 * Either or both of `from`/`to` may be supplied; with neither, defaults to
 * the last 30 days. Capped at 50 results, newest first.
 */
export function SearchEpicTasksByDateTool() {
  return tool(
    async (input) => {
      try {
        const fromDate = input.from ? new Date(input.from) : null;
        const toDate = input.to ? new Date(input.to) : null;
        if (input.from && (!fromDate || isNaN(fromDate.getTime()))) {
          return `Error: invalid \`from\` date "${input.from}". Use ISO 8601 (YYYY-MM-DD or full timestamp).`;
        }
        if (input.to && (!toDate || isNaN(toDate.getTime()))) {
          return `Error: invalid \`to\` date "${input.to}". Use ISO 8601 (YYYY-MM-DD or full timestamp).`;
        }
        // When `to` is a bare date (no time), include the entire day by
        // bumping it to end-of-day. Avoids "I asked about Tuesday and didn't
        // get the epic created at Tuesday 14:00".
        if (toDate && /^\d{4}-\d{2}-\d{2}$/.test(input.to ?? "")) {
          toDate.setUTCHours(23, 59, 59, 999);
        }

        // Default window: last 30 days. Bounded on both sides explicitly so
        // the SQL plan stays predictable on huge tables.
        const effectiveFrom =
          fromDate ??
          new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const effectiveTo = toDate ?? new Date();

        const epics: Array<EpicTask> = await EpicTask.findAll({
          where: {
            createdAt: {
              [Op.between]: [effectiveFrom, effectiveTo],
            },
          },
          order: [["createdAt", "DESC"]],
          limit: 50,
          attributes: ["id", "title", "description", "status", "createdAt", "completedAt"],
        });

        if (epics.length === 0) {
          return (
            `No epic tasks found between ${effectiveFrom.toISOString()} and ${effectiveTo.toISOString()}.\n` +
            `Try widening the window — e.g. pass a wider \`from\`/\`to\` range, or omit them ` +
            `entirely to fall back to the last 30 days.`
          );
        }

        // Surface task counts so the user can quickly see "this epic had 4
        // tasks across 2 stages" without a follow-up call.
        const taskCounts = await sequelize.query<{ epic_task_id: string; task_count: string }>(
          `SELECT ts.epic_task_id, COUNT(at.id)::text AS task_count
             FROM task_stages ts
             LEFT JOIN agent_tasks at ON at.task_stage_id = ts.id
            WHERE ts.epic_task_id IN (:epicIds)
            GROUP BY ts.epic_task_id`,
          {
            replacements: { epicIds: epics.map((e) => e.id) },
            type: QueryTypes.SELECT,
          },
        );
        const countByEpic = new Map(taskCounts.map((r) => [r.epic_task_id, Number(r.task_count)]));

        let summary =
          `Found ${epics.length} epic task(s) between ${effectiveFrom.toISOString().slice(0, 10)} ` +
          `and ${effectiveTo.toISOString().slice(0, 10)} (newest first):\n\n`;
        for (const epic of epics) {
          const taskCount = countByEpic.get(epic.id) ?? 0;
          summary += `### ${epic.title}\n`;
          summary += `- **Epic ID:** \`${epic.id}\`\n`;
          summary += `- **Status:** ${epic.status}\n`;
          summary += `- **Created:** ${epic.createdAt.toISOString()}\n`;
          if (epic.completedAt) {
            summary += `- **Completed:** ${epic.completedAt.toISOString()}\n`;
          }
          summary += `- **Tasks attached:** ${taskCount}\n`;
          // Description is returned in full (no truncation) — the user might
          // want to reuse the scope verbatim in a new epic, paraphrase it,
          // or just be reminded of what was originally requested. Truncating
          // makes that flow lossy. Each result is one description, capped at
          // 50 results, so the worst-case payload is bounded.
          if (epic.description) {
            summary += `- **Description:**\n\n  > ${epic.description.replace(/\n/g, "\n  > ")}\n`;
          }
          summary += "\n";
        }
        summary +=
          `**Follow-up options once you've picked the epic the user means:**\n` +
          `- To dive into the epic's stages and tasks (descriptions, statuses, PR info, summary ` +
          `file paths) — call \`get_epic_task_stages_and_tasks\` with the \`epicId\`. From there ` +
          `pass any \`summaryFilePath\` to \`send_file_to_user\` to deliver as a chat attachment.\n` +
          `- To reuse the scope in a new epic — copy or paraphrase the description above into a ` +
          `new \`create_epic_plan\` call, with whatever changes the user requested. Reference the ` +
          `original epic by id in your reply so the user knows what you're building on.\n` +
          `- To answer a direct question about scope or what was done — answer straight from the ` +
          `description above; no further tool calls needed.`;
        return summary;
      } catch (err: any) {
        logger.error("SearchEpicTasksByDate: failed", { error: err.message });
        return `Error searching epic tasks: ${err.message}`;
      }
    },
    {
      name: "search_epic_tasks_by_date",
      description:
        "General-purpose lookup of past epic tasks by creation date. Returns id, title, status, " +
        "created/completed timestamps, attached-task count, and the full description for each match " +
        "(up to 50 newest-first). Use this whenever the user references a past epic — by time, " +
        "by topic, or by approximate description — and you need the original scope text or the id.\n\n" +
        "Common follow-ups (the tool response also names them):\n" +
        "- Drill into stages and tasks → `get_epic_task_stages_and_tasks` (then `send_file_to_user` " +
        "for any task's `summaryFilePath`).\n" +
        "- Build a new epic that references / extends an old one → copy or paraphrase the returned " +
        "description into a new `create_epic_plan` call.\n" +
        "- Answer a scope question directly → use the returned description; no further tool call needed.",
      schema: z.object({
        from: z.string().optional().describe(
          "ISO 8601 lower bound for `created_at` (inclusive). Bare dates like '2026-04-22' are " +
          "interpreted as start-of-day UTC. Omit for 'last 30 days'.",
        ),
        to: z.string().optional().describe(
          "ISO 8601 upper bound for `created_at` (inclusive). Bare dates like '2026-04-22' are " +
          "auto-extended to end-of-day UTC so the whole day is included. Omit for 'now'.",
        ),
      }),
    },
  );
}

// ─── Get full stage + task structure for an epic ────────────────────────────

/**
 * Returns the entire structure of an epic — all stages with their metadata
 * (title, description, kind, status, sort order, PR info) and every task
 * under each stage with its metadata (title, description, status, sort
 * order, summary file path, completion timestamp). Output is hierarchical:
 * epic header → stage 1 + its tasks → stage 2 + its tasks → ...
 *
 * Replaces the older `get_epic_task_summaries` tool. The previous tool
 * returned a flat task list partitioned by "has summary / doesn't" — useful
 * only for the deliver-files flow. The new shape covers the broader use
 * cases: deliver summaries, browse what was scoped/built, find a specific
 * stage's PR, copy a stage/task description into a new epic, etc.
 *
 * `summaryFilePath` (when present) is an absolute path under the agent's
 * workspace — pass directly to `send_file_to_user` to attach in chat.
 */
export function GetEpicTaskStagesAndTasksTool() {
  return tool(
    async (input) => {
      try {
        const epic = await EpicTask.findByPk(input.epicId, {
          attributes: ["id", "title", "description", "status", "createdAt", "completedAt"],
        });
        if (!epic) {
          return `Error: epic with id "${input.epicId}" not found.`;
        }

        const stages = await TaskStage.findAll({
          where: { epicTaskId: epic.id },
          attributes: [
            "id", "title", "description", "status", "kind", "sortOrder",
            "prUrl", "prNumber", "prStatus", "completedAt",
          ],
          order: [["sortOrder", "ASC"]],
        });

        if (stages.length === 0) {
          return `Epic "${epic.title}" has no stages.`;
        }

        const tasks = await AgentTask.findAll({
          where: { taskStageId: stages.map((s) => s.id) },
          attributes: [
            "id", "taskStageId", "title", "description", "status",
            "sortOrder", "summaryFilePath", "startedAt", "completedAt",
          ],
          order: [["sortOrder", "ASC"]],
        });

        const tasksByStage = new Map<string, typeof tasks>();
        for (const t of tasks) {
          const arr = tasksByStage.get(t.taskStageId) ?? [];
          arr.push(t);
          tasksByStage.set(t.taskStageId, arr);
        }

        let result = `# Epic: "${epic.title}"\n\n`;
        result += `- **Epic ID:** \`${epic.id}\`\n`;
        result += `- **Status:** ${epic.status}\n`;
        result += `- **Created:** ${epic.createdAt.toISOString()}\n`;
        if (epic.completedAt) {
          result += `- **Completed:** ${epic.completedAt.toISOString()}\n`;
        }
        result += `- **Stages:** ${stages.length} ` +
          `(${stages.length === 1 ? "the only stage" : `1 of ${stages.length}` + (stages.length > 1 ? ` through ${stages.length} of ${stages.length}` : "")})\n\n`;
        if (epic.description) {
          result += `**Epic description:**\n\n> ${epic.description.replace(/\n/g, "\n> ")}\n\n`;
        }
        result += `---\n\n`;

        const totalStages = stages.length;
        let summaryFileCount = 0;
        for (const stage of stages) {
          const stageTasks = tasksByStage.get(stage.id) ?? [];
          const isLast = stage.sortOrder === Math.max(...stages.map((s) => s.sortOrder));
          result += `## Stage ${stage.sortOrder + 1} of ${totalStages}: "${stage.title}"`;
          if (stage.kind === "plan") result += ` _(plan — no PR)_`;
          if (isLast) result += ` _(final stage)_`;
          result += `\n\n`;
          result += `- **Stage ID:** \`${stage.id}\`\n`;
          result += `- **Status:** ${stage.status}\n`;
          if (stage.completedAt) {
            result += `- **Completed:** ${stage.completedAt.toISOString()}\n`;
          }
          if (stage.prNumber) {
            result += `- **PR:** #${stage.prNumber}` +
              (stage.prUrl ? ` (${stage.prUrl})` : "") +
              (stage.prStatus ? ` — ${stage.prStatus}` : "") + `\n`;
          } else if (stage.kind !== "plan") {
            result += `- **PR:** _not yet created_\n`;
          }
          if (stage.description) {
            result += `- **Stage description:**\n\n  > ${stage.description.replace(/\n/g, "\n  > ")}\n`;
          }

          if (stageTasks.length === 0) {
            result += `\n_(no tasks defined under this stage)_\n\n`;
            continue;
          }

          result += `\n### Tasks (${stageTasks.length})\n\n`;
          for (const t of stageTasks) {
            if (t.summaryFilePath) summaryFileCount++;
            result += `#### Task ${t.sortOrder + 1}: ${t.title}\n\n`;
            result += `- **Task ID:** \`${t.id}\`\n`;
            result += `- **Status:** ${t.status}\n`;
            if (t.startedAt) {
              result += `- **Started:** ${t.startedAt.toISOString()}\n`;
            }
            if (t.completedAt) {
              result += `- **Completed:** ${t.completedAt.toISOString()}\n`;
            }
            if (t.summaryFilePath) {
              result += `- **Summary file:** \`${t.summaryFilePath}\` ` +
                `_(pass to \`send_file_to_user\` to deliver as chat attachment)_\n`;
            } else {
              result += `- **Summary file:** _none on record_ ` +
                `_(task either predates the summary feature, or the CLI skipped the mandatory write — rare; usually a CLI error)_\n`;
            }
            if (t.description) {
              result += `- **Task description:**\n\n  > ${t.description.replace(/\n/g, "\n  > ")}\n`;
            }
            result += `\n`;
          }
        }

        result += `---\n\n`;
        result += `**Summary files available:** ${summaryFileCount} of ${tasks.length} task(s). ` +
          `For "send me what was done" requests, pass each \`Summary file\` path above to ` +
          `\`send_file_to_user\` and include the returned chips verbatim in your reply.`;

        return result;
      } catch (err: any) {
        logger.error("GetEpicTaskStagesAndTasks: failed", { error: err.message });
        return `Error fetching epic stages/tasks: ${err.message}`;
      }
    },
    {
      name: "get_epic_task_stages_and_tasks",
      description:
        "Returns the complete stage + task structure of an epic — every stage with its metadata " +
        "(title, description, kind, status, PR info) and every task under each stage (title, " +
        "description, status, summary file path, timestamps), organized hierarchically. Use this " +
        "AFTER `search_epic_tasks_by_date` has identified the epic the user means, whenever you " +
        "need ANY detail about the epic's interior:\n" +
        "- Deliver per-task summary files → pass each `summaryFilePath` to `send_file_to_user`.\n" +
        "- Browse what was scoped or built → read each stage's title/description and its tasks' " +
        "descriptions.\n" +
        "- Find a specific stage's PR → look at the stage's PR number/URL/status.\n" +
        "- Reuse a stage or task description in a new `create_epic_plan` call.\n" +
        "- Answer scope/status questions directly from the structure.",
      schema: z.object({
        epicId: z.string().uuid().describe(
          "The id of the epic whose full structure you want — typically copied verbatim from " +
          "an earlier `search_epic_tasks_by_date` result the user has just confirmed.",
        ),
      }),
    },
  );
}

// ─── Reset a stuck (in_progress) task after a server crash ──────────────────

/**
 * Recovery tool for tasks left orphaned at `agent_tasks.status='in_progress'`
 * (with `task_executions.status='running'`) because the server process died
 * mid-execution — crash, restart, OOM, deploy. Without this tool the
 * orchestrator has no way to free the task: `resolveNextRetryableTask` only
 * picks up `ready` tasks (normal flow) and `failed` tasks (mid-stage failure
 * recovery), so an `in_progress` task is invisible to it and `execute_epic_task`
 * falsely reports "no actionable tasks".
 *
 * Recovery procedure (per stuck task, executed in order):
 *   1. Update the latest `task_executions` row from `running` → `failed`,
 *      set `completed_at`, and store the reset reason in the `error` column
 *      so the lifecycle is consistent (no orphan running rows).
 *   2. Flip `agent_tasks.status` from `in_progress` → `failed` and clear
 *      `completed_at`. Routing it to `failed` (not `ready`) means
 *      `resolveNextRetryableTask`'s failed-task fallback picks it up and
 *      `execute_epic_task` auto-switches to retry mode with `--resume <prev
 *      session>`, preserving prior CLI context.
 *
 * `propagateStatus` no longer cascades `failed` up — failure is per-TASK
 * only — so calling it here would correctly leave the stage and epic at
 * `in_progress`. We still pin them explicitly after the task flip as a
 * belt-and-suspenders measure: stages with stuck tasks may have been at
 * `pending` if the crash happened mid-startup, and the retry path requires
 * `ts.status='in_progress'` for `resolveNextRetryableTask`'s failed-task
 * fallback to find the task.
 */
export function ResetStuckTaskTool() {
  return tool(
    async (input) => {
      try {
        const epic = await resolveActiveEpic();

        const stuckTasks = await sequelize.query<AgentTask>(
          `SELECT at.*
             FROM agent_tasks at
             JOIN task_stages ts ON at.task_stage_id = ts.id
            WHERE ts.epic_task_id = :epicId
              AND at.status = 'in_progress'
            ORDER BY ts.sort_order, at.sort_order`,
          { replacements: { epicId: epic.id }, type: QueryTypes.SELECT },
        );

        if (stuckTasks.length === 0) {
          return (
            `No stuck tasks found in epic "${epic.title}". No task is currently at ` +
            `status='in_progress'. If you wanted to retry a 'failed' task, just call ` +
            `execute_epic_task — it auto-detects mid-stage failures and switches into retry ` +
            `mode on its own. If you wanted to retry a stage whose tasks are all 'completed' ` +
            `(PR-review feedback), use request_stage_changes first.`
          );
        }

        const reason =
          input.reason?.trim() ||
          "Server interrupted execution before the task could finish (crash, restart, or deploy).";
        const errorNote = `Reset by orchestrator via reset_stuck_task: ${reason}`;

        const resetTitles: string[] = [];
        let executionsFlipped = 0;
        for (const task of stuckTasks) {
          const lastExec = await TaskExecution.findOne({
            where: { agentTaskId: task.id },
            order: [["attempt_number", "DESC"]],
          });
          if (lastExec && lastExec.status === ("running" as TaskExecutionStatus)) {
            await lastExec.update({
              status: "failed" as TaskExecutionStatus,
              error: errorNote,
              completedAt: new Date(),
            });
            executionsFlipped++;
          }

          await AgentTask.update(
            { status: "failed" as AgentTaskStatus, completedAt: null },
            { where: { id: task.id } },
          );
          resetTitles.push(`"${task.title}"`);
        }

        // Hold the stage(s) and epic at `in_progress` (do NOT call
        // propagateStatus — it would cascade `failed` to the stage and the
        // epic and lock the whole epic out of resolveActiveEpic).
        const affectedStageIds = Array.from(
          new Set(stuckTasks.map((t) => t.taskStageId)),
        );
        await TaskStage.update(
          { status: "in_progress" as TaskStageStatus },
          { where: { id: affectedStageIds } },
        );
        await EpicTask.update(
          { status: "in_progress" as EpicTaskStatus },
          { where: { id: epic.id } },
        );

        logger.warn("ResetStuckTaskTool: reset stuck tasks", {
          epicId: epic.id,
          epicTitle: epic.title,
          taskCount: resetTitles.length,
          executionsFlipped,
          stageCount: affectedStageIds.length,
          reason,
        });

        return (
          `Reset ${resetTitles.length} stuck task(s) in epic "${epic.title}" ` +
          `(epic and stage(s) preserved at 'in_progress' — NOT cancelled or failed): ` +
          `${resetTitles.join(", ")}.\n\n` +
          `- task_executions: flipped ${executionsFlipped} 'running' row(s) to 'failed' ` +
          `(error: ${errorNote}).\n` +
          `- agent_tasks: flipped from 'in_progress' to 'failed' and cleared completed_at.\n` +
          `- Affected stage(s) pinned at 'in_progress' (${affectedStageIds.length} stage(s)).\n` +
          `- Epic pinned at 'in_progress'.\n\n` +
          `Next step: call execute_epic_task. resolveNextRetryableTask's failed-task fallback ` +
          `will pick up the first reset task, the tool auto-switches to retry mode, and the ` +
          `previous Claude CLI session is resumed so prior context is preserved. No manual ` +
          `feedback is required — a neutral 'previous attempt failed before it could finish' ` +
          `stub is synthesized when none is stored.`
        );
      } catch (err: any) {
        logger.error("ResetStuckTaskTool: failed", { error: err.message });
        return `Error resetting stuck task: ${err.message}`;
      }
    },
    {
      name: "reset_stuck_task",
      description:
        "Recovery tool — flips task(s) stuck at agent_tasks.status='in_progress' (with the latest " +
        "task_executions row stuck at status='running') back into the retry pipeline after the server " +
        "process died mid-execution (crash, restart, OOM, deploy). " +
        "Symptom: get_epic_status shows a task at 'in_progress' but no Claude CLI run is actually " +
        "live, and execute_epic_task reports 'no actionable tasks' even though the stage is clearly " +
        "unfinished.\n\n" +
        "What it does (per stuck task, in order):\n" +
        "1. Marks the latest task_executions row 'failed' (was 'running') with the reset reason in " +
        "the error column so no orphan running rows remain.\n" +
        "2. Flips agent_tasks.status from 'in_progress' to 'failed' and clears completed_at.\n" +
        "3. Re-runs propagateStatus so the stage / epic statuses recompute.\n\n" +
        "After this returns, call execute_epic_task — it picks up the failed task via the existing " +
        "mid-stage-failure fallback, auto-switches to retry mode, and resumes the previous Claude " +
        "CLI session so prior context is preserved.\n\n" +
        "Auto-resolves the active epic; takes no IDs.\n\n" +
        "Do NOT use this tool for: normal failures (call execute_epic_task), completed tasks, or " +
        "PR-review feedback (call request_stage_changes). Only for genuinely orphaned 'in_progress' " +
        "tasks left over after a server crash.",
      schema: z.object({
        reason: z.string().optional().describe(
          "Optional short reason explaining why the task is being reset (e.g. 'server restarted " +
          "during deploy', 'process OOMed at 03:14'). Stored on the failed execution row's error " +
          "column for audit. Defaults to a generic 'server interrupted execution' message.",
        ),
      }),
    },
  );
}
