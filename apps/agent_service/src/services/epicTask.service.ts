import { TaskStage, AgentTask, EpicTask, TaskExecution, SingleChat, sequelize } from "@scheduling-agent/database";
import { QueryTypes } from "sequelize";
import type { AgentTaskStatus, PrStatus, EpicTaskId } from "@scheduling-agent/types";
import { getReadyTasks } from "../tools/epicTaskTools";
import { agentChatQueue } from "../queues/agentChat.bull";
import { logger } from "../logger";

export class EpicTaskService {
  async handlePrApproval(repositoryId: string, prNumber: number): Promise<{
    stage: TaskStage;
    readyTasks: AgentTask[];
    epicCompleted: boolean;
  }> {
    const stage = await TaskStage.findOne({
      where: { repositoryId, prNumber },
    });
    if (!stage) {
      throw new Error(`No stage found for repository ${repositoryId} PR #${prNumber}`);
    }

    await stage.update({ prStatus: "approved" as PrStatus });

    // Find pending tasks in the next stage(s) that are now unblocked by this PR approval
    const newlyReady = await sequelize.query<AgentTask>(
      `SELECT at.*
       FROM agent_tasks at
       JOIN task_stages ts ON at.task_stage_id = ts.id
       WHERE ts.epic_task_id = :epicId
         AND at.status = 'pending'
         -- All previous stages must be completed AND PR-approved
         AND NOT EXISTS (
           SELECT 1
           FROM task_stages prev
           WHERE prev.epic_task_id = ts.epic_task_id
             AND prev.sort_order < ts.sort_order
             AND (
               prev.status <> 'completed'
               OR COALESCE(prev.pr_status, 'none') NOT IN ('approved', 'merged')
             )
         )
       ORDER BY ts.sort_order, at.sort_order`,
      { replacements: { epicId: stage.epicTaskId }, type: QueryTypes.SELECT },
    );

    if (newlyReady.length > 0) {
      await AgentTask.update(
        { status: "ready" as AgentTaskStatus },
        { where: { id: newlyReady.map((t) => t.id) } },
      );

      // Auto-continue: enqueue a job so the orchestrator picks up the next stage
      await this.enqueueEpicContinuation(stage.epicTaskId, newlyReady.length);
    }

    // Check if all stages are fully done (tasks completed + PR approved/merged or no PR)
    const epicCompleted = await this.checkAndFinalizeEpic(stage.epicTaskId);

    return { stage, readyTasks: newlyReady, epicCompleted };
  }

  /**
   * Handles PR rejection (changes requested). Finds the completed tasks that
   * produced the PR, resets them for retry with review comments as feedback,
   * and enqueues a retry message to the orchestrator.
   */
  async handlePrChangesRequested(
    repositoryId: string,
    prNumber: number,
    comments: { path?: string; line?: number; body: string }[],
    reviewBody: string | null,
  ): Promise<{ stage: TaskStage; retryTaskIds: string[] }> {
    const stage = await TaskStage.findOne({
      where: { repositoryId, prNumber },
      include: [{ model: AgentTask, as: "tasks" }],
    });
    if (!stage) {
      throw new Error(`No stage found for repository ${repositoryId} PR #${prNumber}`);
    }

    await stage.update({ prStatus: "changes_requested" as PrStatus });

    // Find completed tasks in this stage — these are the ones that produced the PR
    const tasks = (stage as any).tasks as AgentTask[];
    const completedTasks = tasks.filter((t) => t.status === "completed");
    if (completedTasks.length === 0) {
      throw new Error(`No completed tasks found in stage "${stage.title}" to retry`);
    }

    // Format review comments as structured feedback
    const feedbackParts: string[] = [];
    if (reviewBody?.trim()) {
      feedbackParts.push(`## Review Summary\n${reviewBody.trim()}`);
    }
    if (comments.length > 0) {
      feedbackParts.push("## Inline Comments");
      for (const c of comments) {
        if (c.path) {
          feedbackParts.push(`### \`${c.path}\`${c.line ? ` (line ${c.line})` : ""}\n${c.body}`);
        } else {
          feedbackParts.push(c.body);
        }
      }
    }
    const feedback = feedbackParts.join("\n\n") || "Changes requested on the PR. Please review and fix.";

    // Reset each completed task and store feedback on the latest execution
    const retryTaskIds: string[] = [];
    for (const task of completedTasks) {
      // Store feedback on the latest execution for context
      const lastExec = await TaskExecution.findOne({
        where: { agentTaskId: task.id },
        order: [["attempt_number", "DESC"]],
      });
      if (lastExec) {
        await lastExec.update({ feedback });
      }

      // Reset task to ready so the orchestrator picks it up for retry
      await task.update({
        status: "ready" as AgentTaskStatus,
        completedAt: null,
      });
      retryTaskIds.push(task.id);
    }

    // Reset stage status back to in_progress
    await stage.update({ status: "in_progress", completedAt: null });

    // Enqueue retry message to the orchestrator
    await this.enqueueRetryAfterReview(stage.epicTaskId, retryTaskIds, feedback);

    logger.info("PR changes requested — tasks reset for retry", {
      stageId: stage.id,
      epicTaskId: stage.epicTaskId,
      prNumber,
      retryTaskIds,
      commentCount: comments.length,
    });

    return { stage, retryTaskIds };
  }

  /**
   * Enqueues a message so the orchestrator retries tasks after PR review feedback.
   */
  private async enqueueRetryAfterReview(
    epicTaskId: string,
    taskIds: string[],
    feedback: string,
  ): Promise<void> {
    try {
      const epic = await EpicTask.findByPk(epicTaskId);
      if (!epic) return;

      const singleChat = await SingleChat.findOne({
        where: { agentId: epic.agentId, userId: epic.userId },
        attributes: ["id"],
      });

      const requestId = `epic-continuation-${epicTaskId}-pr-review-${Date.now()}`;

      // Truncate feedback for the message if very long — full feedback is stored on TaskExecution
      const feedbackPreview = feedback.length > 2000
        ? feedback.slice(0, 2000) + "\n\n... (truncated — full feedback stored on task execution)"
        : feedback;

      await agentChatQueue.add("epic_pr_review_retry", {
        userId: epic.userId,
        message:
          `[PR Changes Requested — retry needed]\n\n` +
          `The pull request for epic "${epic.title}" (${epicTaskId}) received review feedback. ` +
          `${taskIds.length} task(s) need to be re-executed with the reviewer's feedback.\n\n` +
          `Task IDs to retry: ${taskIds.join(", ")}\n\n` +
          `**Review Feedback:**\n${feedbackPreview}\n\n` +
          `For each task, use execute_epic_task in retry mode:\n` +
          `execute_epic_task({ mode: "retry", taskId: "<id>", feedback: "<the review feedback>" })\n\n` +
          `The feedback is already stored on each task's latest execution. ` +
          `After fixing, the orchestrator should update the PR. ` +
          `Remember to write any lessons learned to your notes or memory for future reference.`,
        requestId,
        groupId: null,
        singleChatId: singleChat?.id ?? null,
        agentId: epic.agentId,
        mentionsAgent: true,
        displayName: "System",
      } as any);

      logger.info("Enqueued retry after PR review", {
        epicTaskId,
        taskIds,
        requestId,
      });
    } catch (err: any) {
      logger.error("Failed to enqueue retry after PR review", {
        epicTaskId,
        error: err.message,
      });
    }
  }

  /**
   * Enqueues a synthetic continuation message so the orchestrator
   * automatically starts executing newly-ready tasks after a PR approval.
   */
  private async enqueueEpicContinuation(
    epicTaskId: string,
    readyTaskCount: number,
  ): Promise<void> {
    try {
      const epic = await EpicTask.findByPk(epicTaskId);
      if (!epic) return;

      // Find the chat context (singleChat) for this agent + user
      const singleChat = await SingleChat.findOne({
        where: { agentId: epic.agentId, userId: epic.userId },
        attributes: ["id"],
      });

      const contRequestId = `epic-continuation-${epicTaskId}-pr-${Date.now()}`;

      await agentChatQueue.add("epic_pr_continuation", {
        userId: epic.userId,
        message:
          `[PR Approved — automatic continuation] The pull request for the previous stage has been approved. ` +
          `${readyTaskCount} task(s) in epic "${epic.title}" (${epicTaskId}) are now ready. ` +
          `Continue executing the next ready task using execute_epic_task with epicId "${epicTaskId}". ` +
          `Provide a progress update to the user.`,
        requestId: contRequestId,
        groupId: null,
        singleChatId: singleChat?.id ?? null,
        agentId: epic.agentId,
        mentionsAgent: true,
        displayName: "System",
      } as any);

      logger.info("Enqueued epic continuation after PR approval", {
        epicTaskId,
        agentId: epic.agentId,
        userId: epic.userId,
        readyTaskCount,
        contRequestId,
      });
    } catch (err: any) {
      logger.error("Failed to enqueue epic continuation after PR approval", {
        epicTaskId,
        error: err.message,
      });
    }
  }

  /**
   * Checks whether all stages in the epic are fully done (tasks completed +
   * PR approved/merged, or no PR). If so, marks the epic as completed and
   * notifies the user via the orchestrator.
   */
  private async checkAndFinalizeEpic(epicTaskId: string): Promise<boolean> {
    const allStages = await TaskStage.findAll({
      where: { epicTaskId },
    });

    const allFullyDone = allStages.every(
      (s) =>
        s.status === "completed" &&
        (!s.prNumber || ["approved", "merged"].includes(s.prStatus ?? "")),
    );

    if (!allFullyDone) return false;

    const epic = await EpicTask.findByPk(epicTaskId);
    if (!epic || epic.status === "completed") return false;

    await epic.update({ status: "completed", completedAt: new Date() });

    logger.info("Epic task fully completed (all stages done + PRs approved)", {
      epicTaskId,
      title: epic.title,
    });

    await this.enqueueEpicCompletionNotification(epic);

    return true;
  }

  /**
   * Sends a completion notification to the user via the orchestrator
   * when the entire epic is finished.
   */
  private async enqueueEpicCompletionNotification(epic: EpicTask): Promise<void> {
    try {
      const singleChat = await SingleChat.findOne({
        where: { agentId: epic.agentId, userId: epic.userId },
        attributes: ["id"],
      });

      const requestId = `epic-completed-${epic.id}-${Date.now()}`;

      await agentChatQueue.add("epic_completed", {
        userId: epic.userId,
        message:
          `[Epic Completed] All stages and pull requests for epic "${epic.title}" (${epic.id}) ` +
          `have been completed and approved. ` +
          `Provide a final summary to the user of what was accomplished across all stages. ` +
          `Use get_epic_status to review the full results, then congratulate the user.`,
        requestId,
        groupId: null,
        singleChatId: singleChat?.id ?? null,
        agentId: epic.agentId,
        mentionsAgent: true,
        displayName: "System",
      } as any);

      logger.info("Enqueued epic completion notification", {
        epicTaskId: epic.id,
        requestId,
      });
    } catch (err: any) {
      logger.error("Failed to enqueue epic completion notification", {
        epicTaskId: epic.id,
        error: err.message,
      });
    }
  }
}
