import type { Queue } from "bullmq";
import type { AgentChatJobData, AgentChatJobResult } from "./queues/agentChat.bull";

let _agentChatQueue: Queue<AgentChatJobData, AgentChatJobResult, string>;

export function setDeps(deps: {
  agentChatQueue: Queue<AgentChatJobData, AgentChatJobResult, string>;
}) {
  _agentChatQueue = deps.agentChatQueue;
}

export function getAgentChatQueue() {
  return _agentChatQueue;
}
