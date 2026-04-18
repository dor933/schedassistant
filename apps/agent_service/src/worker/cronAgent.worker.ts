import { Worker } from "bullmq";
import { AgentCronJob, Agent, SingleChat } from "@scheduling-agent/database";
import {
  CRON_AGENT_QUEUE_NAME,
  cronAgentQueue,
  type CronAgentJobData,
} from "../queues/cronAgent.bull";
import { agentChatQueue } from "../queues/agentChat.bull";
import { getRedisConfig } from "../redisClient";
import { logger } from "../logger";

export type CronAgentWorkerHandle = {
  worker: Worker<CronAgentJobData>;
  stopSync: () => void;
  close: () => Promise<void>;
};

/** Period of the full reconciliation pass. */
const RECONCILE_INTERVAL_MS = Number(
  process.env.CRON_AGENT_RECONCILE_INTERVAL_MS ?? 15_000,
);

/**
 * Reconciles BullMQ job schedulers with the `agent_cron_jobs` table.
 *
 * Upserts a scheduler per enabled row and removes any schedulers that
 * no longer correspond to an enabled DB row. Safe to call repeatedly.
 */
export async function syncCronSchedulers(): Promise<void> {
  const dbJobs = await AgentCronJob.findAll({
    attributes: ["id", "cronExpression", "timezone", "enabled"],
  });
  const enabled = dbJobs.filter((j) => j.enabled);
  const enabledIds = new Set(enabled.map((j) => j.id));

  // Upsert every enabled row — schedulerId = cron job id (stable).
  for (const job of enabled) {
    try {
      await cronAgentQueue.upsertJobScheduler(
        job.id,
        { pattern: job.cronExpression, tz: job.timezone },
        { data: { cronJobId: job.id } },
      );
    } catch (err) {
      logger.error("cronAgent: failed to upsert scheduler", {
        cronJobId: job.id,
        error: String(err),
      });
    }
  }

  // Remove any scheduler whose DB row is gone or disabled.
  try {
    const existing = await cronAgentQueue.getJobSchedulers(0, -1, true);
    for (const sched of existing) {
      const id = (sched as { id?: string; key?: string }).id
        ?? (sched as { key?: string }).key;
      if (!id) continue;
      if (!enabledIds.has(id)) {
        await cronAgentQueue.removeJobScheduler(id);
        logger.info("cronAgent: removed scheduler", { cronJobId: id });
      }
    }
  } catch (err) {
    logger.error("cronAgent: failed to list/remove stale schedulers", {
      error: String(err),
    });
  }
}

/**
 * Worker that consumes scheduler ticks and turns each into a regular
 * `agent_chat_jobs` message. Also runs a periodic reconcile loop so
 * changes made by user_app (which doesn't talk to BullMQ directly) are
 * picked up without cross-service Redis coupling.
 */
export function startCronAgentWorker(): CronAgentWorkerHandle {
  const worker = new Worker<CronAgentJobData>(
    CRON_AGENT_QUEUE_NAME,
    async (job) => {
      const { cronJobId } = job.data;

      const cronJob = await AgentCronJob.findByPk(cronJobId);
      if (!cronJob) {
        logger.warn("cronAgent: tick for unknown cron job (removing scheduler)", {
          cronJobId,
        });
        try {
          await cronAgentQueue.removeJobScheduler(cronJobId);
        } catch {
          /* ignore */
        }
        return;
      }
      if (!cronJob.enabled) {
        logger.info("cronAgent: tick for disabled job (skipping)", { cronJobId });
        return;
      }

      const agent = await Agent.findByPk(cronJob.agentId, {
        attributes: ["id", "definition", "agentName"],
      });
      if (!agent) {
        logger.warn("cronAgent: tick for missing agent (disabling job)", {
          cronJobId,
          agentId: cronJob.agentId,
        });
        await cronJob.update({
          enabled: false,
          lastStatus: "failed",
          lastError: "Agent no longer exists",
          lastRunAt: new Date(),
        });
        return;
      }

      // Need a user identity for the chat pipeline. Prefer the creator; otherwise
      // fall back to any user who has a SingleChat with this agent.
      let targetUserId: number | null = cronJob.createdByUserId;
      let singleChatId: string | null = null;
      if (targetUserId != null) {
        const sc = await SingleChat.findOne({
          where: { userId: targetUserId, agentId: agent.id },
          attributes: ["id"],
        });
        singleChatId = sc?.id ?? null;
      }
      if (!singleChatId) {
        const sc = await SingleChat.findOne({
          where: { agentId: agent.id },
          attributes: ["id", "userId"],
        });
        if (sc) {
          singleChatId = sc.id;
          targetUserId = sc.userId;
        }
      }
      if (targetUserId == null || !singleChatId) {
        logger.warn("cronAgent: no usable SingleChat for agent — skipping tick", {
          cronJobId,
          agentId: agent.id,
        });
        await cronJob.update({
          lastStatus: "failed",
          lastError: "No SingleChat available to deliver scheduled message",
          lastRunAt: new Date(),
        });
        return;
      }

      const requestId = `cron-${cronJob.id}-${Date.now()}`;
      await agentChatQueue.add("cron_tick", {
        userId: targetUserId,
        agentId: agent.id,
        singleChatId,
        message: cronJob.prompt,
        requestId,
        mentionsAgent: true,
        displayName: `cron:${cronJob.name}`,
      });

      await cronJob.update({
        lastRunAt: new Date(),
        lastStatus: "enqueued",
        lastError: null,
      });

      logger.info("cronAgent: enqueued agent_chat job", {
        cronJobId,
        agentId: agent.id,
        requestId,
      });
    },
    {
      connection: getRedisConfig(),
      concurrency: Number(process.env.CRON_AGENT_WORKER_CONCURRENCY ?? "4"),
    },
  );

  worker.on("failed", async (job, err) => {
    const cronJobId = job?.data?.cronJobId;
    logger.error("cronAgent: tick failed", {
      bullJobId: job?.id,
      cronJobId,
      error: err?.message ?? String(err),
    });
    if (cronJobId) {
      try {
        await AgentCronJob.update(
          {
            lastStatus: "failed",
            lastError: err?.message ?? String(err),
            lastRunAt: new Date(),
          },
          { where: { id: cronJobId } },
        );
      } catch {
        /* ignore */
      }
    }
  });

  const syncTimer = setInterval(() => {
    syncCronSchedulers().catch((err) =>
      logger.error("cronAgent: reconcile pass failed", { error: String(err) }),
    );
  }, RECONCILE_INTERVAL_MS);

  logger.info("cronAgent worker listening", {
    queue: CRON_AGENT_QUEUE_NAME,
    reconcileIntervalMs: RECONCILE_INTERVAL_MS,
  });

  return {
    worker,
    stopSync: () => clearInterval(syncTimer),
    close: () => worker.close(),
  };
}
