import { Op } from "sequelize";
import { AgentTask, TaskStage, EpicTask } from "@scheduling-agent/database";

const STALE_TASK_CUTOFF_MINUTES = Number(
  process.env.EPIC_BUSY_STALE_CUTOFF_MINUTES ?? "30",
);

export interface EpicBusyResult {
  busy: boolean;
  taskTitle?: string;
  epicTitle?: string;
  epicId?: string;
  epicUserId?: number;
  sameUser?: boolean;
  startedAt?: Date;
}

/**
 * Returns whether the Epic Orchestrator is currently running a task — globally,
 * across ALL users. The orchestrator is a shared singleton agent with a single
 * per-agent thread lock, so exactly one epic can run at a time system-wide.
 *
 * A task counts as "in progress" only if its row was started within the stale
 * cutoff window — this prevents a crashed/orphaned task from permanently
 * blocking further requests.
 *
 * The caller's userId is used purely to tag the result (`sameUser`) so the
 * bounce message can distinguish "your own epic" from "another user's epic".
 */
export async function isEpicOrchestratorBusy(
  callerUserId: number,
): Promise<EpicBusyResult> {
  const cutoff = new Date(Date.now() - STALE_TASK_CUTOFF_MINUTES * 60_000);

  const runningTask = await AgentTask.findOne({
    where: {
      status: "in_progress",
      startedAt: { [Op.gt]: cutoff },
    },
    include: [
      {
        model: TaskStage,
        as: "stage",
        required: true,
        include: [
          {
            model: EpicTask,
            as: "epicTask",
            required: true,
          },
        ],
      },
    ],
    order: [["startedAt", "DESC"]],
  });

  if (!runningTask) return { busy: false };

  const stage = (runningTask as any).stage as TaskStage | undefined;
  const epic = (stage as any)?.epicTask as EpicTask | undefined;

  return {
    busy: true,
    taskTitle: runningTask.title,
    epicTitle: epic?.title,
    epicId: epic?.id,
    epicUserId: epic?.userId,
    sameUser: epic?.userId === callerUserId,
    startedAt: runningTask.startedAt ?? undefined,
  };
}
