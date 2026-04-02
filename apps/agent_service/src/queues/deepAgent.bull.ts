import { Queue, QueueEvents } from "bullmq";
import { getRedisConfig } from "../redisClient";

export const DEEP_AGENT_QUEUE_NAME = "deep_agent_jobs";

const connection = getRedisConfig();

export const deepAgentQueue = new Queue(DEEP_AGENT_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    removeOnComplete: 500,
    removeOnFail: 2000,
    attempts: 1,
  },
});

export const deepAgentQueueEvents = new QueueEvents(DEEP_AGENT_QUEUE_NAME, {
  connection,
});

export type DeepAgentJobData = {
  delegationId: string;
  systemAgentId: number;
  systemAgentSlug: string;
  request: string;
  callerAgentId: string;
  userId: number;
  groupId: string | null;
  singleChatId: string | null;
};

// Global accessor for the queue (used by the DelegateToDeepAgent tool)
let _deepAgentQueue: Queue<DeepAgentJobData> = deepAgentQueue;

export function getDeepAgentQueue(): Queue<DeepAgentJobData> {
  return _deepAgentQueue;
}
