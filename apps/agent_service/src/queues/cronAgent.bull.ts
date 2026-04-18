import { Queue, QueueEvents } from "bullmq";
import { getRedisConfig } from "../redisClient";

export const CRON_AGENT_QUEUE_NAME = "cron_agent_jobs";

const connection = getRedisConfig();

/**
 * Queue that holds BullMQ job schedulers (one per `agent_cron_jobs` row).
 * Each scheduler produces a delayed job on every cron tick; the worker
 * then enqueues a regular message into `agent_chat_jobs`.
 */
export const cronAgentQueue = new Queue(CRON_AGENT_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    removeOnComplete: 500,
    removeOnFail: 2000,
    attempts: 1,
  },
});

export const cronAgentQueueEvents = new QueueEvents(CRON_AGENT_QUEUE_NAME, {
  connection,
});

export type CronAgentJobData = {
  cronJobId: string;
};
