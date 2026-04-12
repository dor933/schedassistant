import { Queue, QueueEvents } from "bullmq";
import { getRedisConfig } from "../redisClient";

export const ROUNDTABLE_QUEUE_NAME = "roundtable_jobs";

const connection = getRedisConfig();

export const roundtableQueue = new Queue(ROUNDTABLE_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    removeOnComplete: 500,
    removeOnFail: 2000,
    attempts: 1,
  },
});

export const roundtableQueueEvents = new QueueEvents(ROUNDTABLE_QUEUE_NAME, {
  connection,
});

export type RoundtableTurnJobData = {
  roundtableId: string;
  agentId: string;
  roundNumber: number;
  userId: number;
  groupId: string | null;
  singleChatId: string | null;
};
