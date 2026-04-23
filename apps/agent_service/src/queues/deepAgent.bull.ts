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
  executorAgentId: string;
  request: string;
  callerAgentId: string;
  userId: number;
  groupId: string | null;
  singleChatId: string | null;
  /**
   * The caller's LangGraph thread id. The executor uses this — not its own
   * fresh thread id — to scope writes into the caller's per-thread session
   * workspace folder, so files end up where the caller will look for them
   * (`<callerWorkspacePath>/threads/<callerThreadId>/`).
   *
   * Optional for backwards compatibility: when absent the executor still
   * writes into the caller's workspace root but no per-thread manifest is
   * captured — same behavior as before this field existed.
   */
  callerThreadId?: string | null;
  /** When true, the caller blocks via waitUntilFinished — skip the delegation_result callback. */
  syncMode?: boolean;
};

// Global accessor for the queue (used by the DelegateToDeepAgent tool)
let _deepAgentQueue: Queue<DeepAgentJobData> = deepAgentQueue;

export function getDeepAgentQueue(): Queue<DeepAgentJobData> {
  return _deepAgentQueue;
}
