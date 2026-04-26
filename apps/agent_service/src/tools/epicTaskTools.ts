import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { execSync } from "child_process";
import { Op, QueryTypes } from "sequelize";
import {
  sequelize,
  Repository,
  EpicTask,
  TaskStage,
  AgentTask,
  TaskExecution,
} from "@scheduling-agent/database";
import type {
  AgentTaskStatus,
  TaskStageStatus,
  PrStatus,
} from "@scheduling-agent/types";
import { logger } from "../logger";
import {
  listProjects,
  getProject,
  getEpic,
  getReadyTasks,
  advanceNextStageReadyTasks,
  createEpicWithPlan,
  executeTask,
  prepareRetry,
  preExecutionSync,
  buildArchitectureContext,
  buildTaskSummaryFilePath,
  captureGitDiff,
  captureStageDiff,
  continueRemainingTasks,
  appendContinuationMarker,
  formatExecutionResult,
  resolveActiveEpic,
  resolveActivePrPendingStage,
  resolveNextRetryableTask,
  EPIC_CONTINUATION_MARKER,
  parseContinuationMarker,
} from "../utils/epicTaskUtils";

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

        // Auto-resolve the active epic — the orchestrator is a system-wide
        // singleton so this is unambiguous. We never accept an epicId/taskId
        // as input because the model would have to carry those across turns
        // and tends to hallucinate them.
        const epic = await resolveActiveEpic();
        const epicId = epic.id;

        // Resolve the working directory and optional agent name from the epic's primary repo.
        async function resolveRepoContext(inputCwd?: string): Promise<{ cwd: string; agentName?: string }> {
          const withRepos = await EpicTask.findByPk(epicId, {
            include: [{ model: Repository, as: "repositories" }],
          });
          const repos = ((withRepos as any)?.repositories ?? []) as Repository[];
          const repoWithPath = repos.find((r) => r.localPath);
          const cwd = inputCwd || repoWithPath?.localPath;
          if (!cwd) {
            throw new Error(
              "cwd is required — no repository has a localPath configured. " +
              "Either pass cwd explicitly or set localPath on the repository.",
            );
          }
          return { cwd, agentName: repoWithPath?.agentName ?? undefined };
        }

        // Build the executor's system prompt. `preExecutionSync` resolves
        // the stage and syncs onto its feature branch, so it needs a taskId
        // to know which stage to use.
        //
        // The session-folder block is THE fix for the cross-thread retry
        // confusion: a task description authored in thread A (and persisted
        // in agent_tasks) may carry a hardcoded `threads/A/...` path. When
        // the user retries the same epic from thread B, we still want the
        // CLI's deliverables to land in B's session folder, not A's. Putting
        // the *current* thread's absolute path in the system prompt with an
        // explicit "any other threads/<id>/ in the description is stale" line
        // overrides the stale path in the description. No DB rewrite needed.
        async function buildSystemPrompt(
          taskId: string,
          userSystemPrompt: string | undefined,
        ): Promise<string | undefined> {
          await preExecutionSync(epicId, taskId);
          const parts: string[] = [];

          if (conversationCtx?.threadId) {
            try {
              const { Agent } = await import("@scheduling-agent/database");
              const agent = await Agent.findByPk(epic.agentId, {
                attributes: ["workspacePath"],
              });
              const workspacePath =
                (agent as { workspacePath?: string | null } | null)?.workspacePath ?? null;
              if (workspacePath) {
                const currentThreadId = conversationCtx.threadId;
                const sessionFolder = `${workspacePath}/threads/${currentThreadId}/`;
                parts.push(
                  `## Session folder for this execution\n` +
                  `The current thread's session folder is **\`${sessionFolder}\`** ` +
                  `(thread ${currentThreadId}). Write every deliverable file (plan, spec, ` +
                  `audit, report) here.\n\n` +
                  `**If the task description references a different \`threads/<id>/\` path, ` +
                  `that path is stale — the task may have been authored from a previous ` +
                  `conversation thread. Always use the current session folder above.** ` +
                  `Specifically, if the task description says e.g. ` +
                  `\`/app/data/workspaces/<agent>/threads/<other-id>/<filename>.md\`, ` +
                  `replace the \`threads/<other-id>\` segment with \`threads/${currentThreadId}\` ` +
                  `before writing.`,
                );

                // Mandatory per-task summary file — captured into
                // `agent_tasks.summary_file_path` after this run so the
                // orchestrator can fan summaries out via `send_file_to_user`
                // for any past or current epic. Path is computed via the
                // same helper used by `recordTaskSummaryFilePath` so the
                // CLI's write target and the DB column always agree.
                const summaryAbsPath = await buildTaskSummaryFilePath({
                  agentId: epic.agentId,
                  threadId: currentThreadId,
                  taskId,
                });
                if (summaryAbsPath) {
                  parts.push(
                    `## Required output: per-task summary file (MANDATORY)\n` +
                    `Before you finish this task — regardless of whether it's a planning task or ` +
                    `a code-change task — you **MUST** write a Markdown summary of what you did to ` +
                    `**\`${summaryAbsPath}\`** using your built-in \`Write\` tool. ` +
                    `Each new attempt overwrites the previous summary at this exact path; do ` +
                    `not pick a different filename, do not append a timestamp, do not put it in ` +
                    `a sub-folder. The downstream system reads this file by exact path.\n\n` +
                    `Contents of the summary, brief and skimmable:\n` +
                    `- **Task title** and a one-sentence restatement of the goal as you understood it.\n` +
                    `- **What you actually did** in this attempt — files created/modified/deleted ` +
                    `(or "no code changes — planning only" for plan tasks), key decisions, anything ` +
                    `non-obvious about the approach.\n` +
                    `- **Outcome** — completed / partial / blocked, with a 1-2 sentence ` +
                    `explanation. If a previous attempt was rejected and you reworked it based on ` +
                    `feedback, note what changed.\n` +
                    `- **Pointers** to any larger artifacts you produced (e.g. "full plan at ` +
                    `\`<other-file>.md\` in the same folder").\n\n` +
                    `This summary is how the user retrieves "what did task X do" later, possibly ` +
                    `from a different chat thread. Skipping it means the orchestrator cannot ` +
                    `surface this task's work via \`send_file_to_user\`. **The summary file write ` +
                    `is a hard requirement of finishing the task — do not exit without it.**`,
                  );
                }
              }
            } catch (err: any) {
              logger.warn("buildSystemPrompt: session-folder injection failed (non-fatal)", {
                epicId,
                threadId: conversationCtx?.threadId,
                error: err?.message,
              });
            }
          }

          const archCtx = await buildArchitectureContext(epicId);
          if (archCtx) parts.push(archCtx);
          if (userSystemPrompt) parts.push(userSystemPrompt);
          return parts.length > 0 ? parts.join("\n\n") : undefined;
        }

        // Resolve the next task to operate on. Prefers a 'ready' task
        // (normal execution or post-request_stage_changes retry), then
        // falls back to a 'failed' task in an in_progress stage (mid-stage
        // CLI failure). Returns null only if there's genuinely nothing
        // left to do.
        const firstTask = await resolveNextRetryableTask(epicId);
        if (!firstTask) {
          const fullEpic = await getEpic(epicId, { includeStages: true, includeTasks: true });
          const stages = ((fullEpic as any)?.stages ?? []) as any[];
          const waitingForReview = stages.filter((s) => s.status === "pr_pending");
          if (waitingForReview.length > 0) {
            const labels = waitingForReview
              .map((s) =>
                s.kind === "plan"
                  ? `"${s.title}" (plan — awaiting your approval)`
                  : `"${s.title}" (PR #${s.prNumber ?? "not opened"})`,
              )
              .join(", ");
            return (
              `No tasks are ready to execute. Waiting for review/approval on: ${labels}.\n` +
              `For code_change stages, the next stage starts when the PR is approved. ` +
              `For plan stages, summarize the plan to the user and call approve_stage with their verbatim approval quote.`
            );
          }
          if (epic.status === "completed") {
            return `All tasks in epic "${epic.title}" have been completed successfully!`;
          }
          return `No actionable tasks found for epic "${epic.title}". Status: ${epic.status}.`;
        }

        // If the picked task is a failed one (mid-stage failure recovery),
        // force retry mode regardless of what the caller passed — a fresh
        // re-run of a failed task without feedback-carrying session resume
        // would lose the context of why it failed.
        const isFailedRecovery = firstTask.status === ("failed" as AgentTaskStatus);
        const effectiveMode = isFailedRecovery ? "retry" : input.mode;

        const { cwd, agentName } = await resolveRepoContext(input.cwd);
        const systemPrompt = await buildSystemPrompt(firstTask.id, input.systemPrompt);

        // Per-task summary capture: same path the system prompt names is
        // passed down to executeTask so it can persist
        // `agent_tasks.summary_file_path` after a successful run. Computed
        // once for the first task; `continueRemainingTasks` recomputes per
        // sub-task using `summaryContext`.
        const summaryContext = conversationCtx?.threadId
          ? { agentId: epic.agentId, threadId: conversationCtx.threadId }
          : undefined;
        const firstTaskSummaryPath = summaryContext
          ? await buildTaskSummaryFilePath({
              agentId: summaryContext.agentId,
              threadId: summaryContext.threadId,
              taskId: firstTask.id,
            })
          : null;

        if (effectiveMode === "retry") {
          // Pull feedback from input, or fall back to what request_stage_changes
          // already stored on the task's latest execution row.
          let feedback = input.feedback;
          if (!feedback) {
            const lastExec = await TaskExecution.findOne({
              where: { agentTaskId: firstTask.id },
              order: [["attempt_number", "DESC"]],
            });
            feedback = lastExec?.feedback ?? undefined;
          }
          // For a mid-stage failed-task recovery, feedback is optional: the
          // model may be retrying a transient CLI crash where there's nothing
          // useful to tell Claude beyond "try again." Synthesize a neutral
          // stub so prepareRetry can still build a resume prompt.
          if (!feedback && isFailedRecovery) {
            feedback =
              "The previous attempt failed before it could finish. " +
              "Resume and complete the original task.";
          }
          if (!feedback) {
            return (
              "Error: retry mode requires feedback — either pass it as an argument " +
              "or call request_stage_changes first (which stores the feedback on the task)."
            );
          }

          const { previousSessionId, resumePrompt, freshPrompt } = await prepareRetry(
            firstTask.id,
            feedback,
          );

          logger.info("ExecuteEpicTask: retrying task", {
            taskId: firstTask.id,
            taskTitle: firstTask.title,
            previousSessionId,
            willResume: !!previousSessionId,
            failedRecovery: isFailedRecovery,
          });

          // If we have a session to resume, also pass the fresh prompt as
          // fallback — if --resume fails at runtime (session expired, file
          // missing), executeTask swaps in a coherent standalone prompt
          // instead of re-sending continuation-style text to an empty session.
          const execution = await executeTask(firstTask.id, {
            cwd,
            promptOverride: previousSessionId ? resumePrompt : freshPrompt,
            resumeSessionId: previousSessionId ?? undefined,
            freshPromptFallback: previousSessionId ? freshPrompt : undefined,
            allowedTools: input.allowedTools,
            maxTurns: input.maxTurns,
            systemPrompt,
            agentName,
            expectedSummaryFilePath: firstTaskSummaryPath,
          });

          let result = await formatExecutionResult(execution, firstTask.id);
          if (execution.status !== "failed") {
            const contResult = await continueRemainingTasks(firstTask.id, {
              cwd, allowedTools: input.allowedTools, maxTurns: input.maxTurns, systemPrompt, agentName,
              summaryContext,
            });
            if (contResult) result += "\n\n---\n\n" + contResult;
          }
          result += await appendContinuationMarker(firstTask.id);
          return result;
        }

        // Normal execution mode — first ready task, fresh run.
        logger.info("ExecuteEpicTask: starting first ready task", {
          epicId,
          taskId: firstTask.id,
          taskTitle: firstTask.title,
        });

        const execution = await executeTask(firstTask.id, {
          cwd,
          allowedTools: input.allowedTools,
          maxTurns: input.maxTurns,
          systemPrompt,
          agentName,
          expectedSummaryFilePath: firstTaskSummaryPath,
        });

        let result = await formatExecutionResult(execution, firstTask.id);
        if (execution.status !== "failed") {
          const contResult = await continueRemainingTasks(firstTask.id, {
            cwd, allowedTools: input.allowedTools, maxTurns: input.maxTurns, systemPrompt, agentName,
            summaryContext,
          });
          if (contResult) result += "\n\n---\n\n" + contResult;
        }
        result += await appendContinuationMarker(firstTask.id);
        return result;
      } catch (err: any) {
        logger.error("ExecuteEpicTask: failed", {
          error: err.message,
          stack: err.stack,
          mode: input.mode ?? "execute",
          hasCwd: !!input.cwd,
        });
        return `Error executing epic task: ${err.message}`;
      }
    },
    {
      name: "execute_epic_task",
      description:
        "Execute the next actionable task in the active epic. No IDs required — the tool auto-resolves the " +
        "active epic (the orchestrator is a system-wide singleton) and picks the next task to run.\n\n" +
        "Task resolution order:\n" +
        "1. The first 'ready' task (normal execution, or post-request_stage_changes retry).\n" +
        "2. Fallback: the first 'failed' task in an in_progress stage (mid-stage CLI failure recovery) — " +
        "in this case the tool auto-switches to retry mode and resumes the previous session.\n\n" +
        "Modes:\n" +
        "- 'execute' (default): start the next ready task fresh.\n" +
        "- 'retry': re-run the next task, resuming its previous Claude CLI session. " +
        "Use this after calling request_stage_changes to reset a pr_pending stage's tasks with feedback. " +
        "Feedback is auto-loaded from the task's execution row if not passed as an argument.\n\n" +
        "After execution you'll receive a detailed report including the git diff. Review it — if fixes are " +
        "needed, call request_stage_changes with your feedback and then retry.\n\n" +
        "The tool automatically continues with the remaining tasks in the same stage after each successful " +
        "execution. When all stage tasks complete, a PR is created automatically.",
      schema: z.object({
        mode: z.enum(["execute", "retry"]).default("execute")
          .describe("'execute' for a normal run, 'retry' to resume the previous CLI session with feedback"),
        feedback: z.string().optional()
          .describe(
            "Optional feedback text for retry mode. If omitted in retry mode, the tool " +
            "loads the feedback that request_stage_changes stored on the task.",
          ),
        cwd: z.string().optional()
          .describe("Working directory override (defaults to the epic's repository localPath)"),
        allowedTools: z.string().optional()
          .describe("Comma-separated list of allowed tools for Claude CLI"),
        maxTurns: z.number().int().positive().optional()
          .describe("Max turns for Claude CLI (defaults to 200)"),
        systemPrompt: z.string().optional()
          .describe("Additional system prompt to append to the executor's context"),
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
        const completedTasks = tasks.filter((t) => t.status === "completed");
        if (completedTasks.length === 0) {
          return `Error: No completed tasks found in stage "${stage.title}" to retry.`;
        }

        const feedback = input.feedback;

        // Store feedback on each task's latest execution and reset task to "ready"
        const retryTaskIds: string[] = [];
        for (const task of completedTasks) {
          const lastExec = await TaskExecution.findOne({
            where: { agentTaskId: task.id },
            order: [["attempt_number", "DESC"]],
          });
          if (lastExec) {
            await lastExec.update({ feedback });
          }

          await task.update({
            status: "ready" as AgentTaskStatus,
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

        const epics = await EpicTask.findAll({
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
