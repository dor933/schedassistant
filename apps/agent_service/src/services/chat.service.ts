import { getAgentChatQueue } from "../deps";
import type { AgentChatJobData } from "../queues/agentChat.bull";

export class ChatService {
  async enqueueChat(data: {
    userId: string;
    message: string;
    requestId?: string;
    displayName?: string;
    groupId?: string;
    singleChatId?: string;
    agentId?: string;
    mentionsAgent?: boolean;
  }): Promise<string> {
    const queue = getAgentChatQueue();
    const requestId = data.requestId ?? crypto.randomUUID();

    await queue.add("chat", {
      userId: data.userId,
      threadId: data.threadId,
      message: data.message,
      requestId,
      ...(data.displayName ? { displayName: data.displayName } : {}),
      ...(data.groupId != null ? { groupId: data.groupId } : {}),
      ...(data.singleChatId != null ? { singleChatId: data.singleChatId } : {}),
      ...(data.agentId != null ? { agentId: data.agentId } : {}),
      ...(data.mentionsAgent != null
        ? { mentionsAgent: data.mentionsAgent }
        : {}),
    } satisfies AgentChatJobData);

    return requestId;
  }
}
