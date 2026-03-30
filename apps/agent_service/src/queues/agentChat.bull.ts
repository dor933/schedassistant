import { Queue, QueueEvents } from "bullmq";
import { getRedisConfig } from "../redisClient";

export const AGENT_CHAT_QUEUE_NAME = "agent_chat_jobs";

const connection = getRedisConfig();

/**
 * Jobs for `/api/chat`: one job per HTTP request; the worker resolves the canonical
 * thread, then runs `graph.invoke` under a per-conversation Redis lock.
 */
export const agentChatQueue = new Queue(AGENT_CHAT_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    removeOnComplete: 1000,
    removeOnFail: 5000,
    attempts: 1,
  },
});

export const agentChatQueueEvents = new QueueEvents(AGENT_CHAT_QUEUE_NAME, {
  connection,
});

export type AgentChatJobData = {
  userId: string;
  message: string;
  requestId: string;
  displayName?: string;
  groupId?: string | null;
  singleChatId?: string | null;
  agentId?: string | null;
  /** When false in a group chat, the message is stored but the agent does not respond. */
  mentionsAgent?: boolean;
};

/** JSON-serializable result returned to the HTTP client after the job completes. */
export type AgentChatJobResult = {
  threadId: string;
  reply: string;
  systemPrompt: string | null;
};

// Queue initialized (logged at startup by the worker)
