import { io, type Socket } from "socket.io-client";
import { GroupMember, MessageNotification } from "@scheduling-agent/database";
import { getIO } from "../server/socketServer";
import { logger } from "../../logger";

const AGENT_SERVICE_URL =
  process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";

let agentSocket: Socket | null = null;

export interface ActiveJobEntry {
  conversationId: string;
  conversationType: "group" | "single";
  userId: number;
  groupId: string | null;
}

/**
 * Queries agent_service for BullMQ jobs that are currently active or waiting.
 * Returns an empty array if the socket is not connected or the call times out.
 */
export function fetchActiveJobs(): Promise<ActiveJobEntry[]> {
  return new Promise((resolve) => {
    if (!agentSocket?.connected) return resolve([]);
    const timeout = setTimeout(() => resolve([]), 3000);
    agentSocket.emit("check:active-jobs", (entries: ActiveJobEntry[]) => {
      clearTimeout(timeout);
      resolve(entries);
    });
  });
}

/** Payload shape emitted by agent_service on `agent:reply`. */
interface AgentReplyOk {
  requestId: string;
  userId: number;
  threadId: string;
  groupId: string | null;
  singleChatId: string | null;
  ok: true;
  reply: string;
  systemPrompt: string | null;
  modelSlug?: string;
  vendorSlug?: string;
  modelName?: string;
}

interface AgentReplyError {
  requestId: string;
  userId: number;
  threadId: string;
  groupId: string | null;
  singleChatId: string | null;
  ok: false;
  error: string;
}

type AgentReplyPayload = AgentReplyOk | AgentReplyError;

/** Typing indicator from agent_service. */
interface AgentTypingPayload {
  threadId: string;
  userId: number;
  groupId: string | null;
  singleChatId: string | null;
}

/** What we emit to browser clients on `chat:reply`. */
interface ChatReplyToClient {
  requestId: string;
  threadId: string;
  groupId: string | null;
  singleChatId: string | null;
  conversationId: string;
  conversationType: "group" | "single";
  ok: boolean;
  reply?: string;
  systemPrompt?: string | null;
  error?: string;
  modelSlug?: string;
  vendorSlug?: string;
  modelName?: string;
}

/**
 * Connects the user_app server to the agent_service Socket.IO server.
 * When the agent finishes a chat turn it emits `agent:reply`, and this
 * handler fans the message out to the correct browser-connected users.
 */
export function connectToAgentService(): void {
  if (agentSocket?.connected) return;

  agentSocket = io(AGENT_SERVICE_URL, {
    path: "/agent-socket",
    transports: ["websocket", "polling"],
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 1000,
  });

  agentSocket.on("connect", () => {
    logger.info("Connected to agent_service socket");
  });

  agentSocket.on("connect_error", (err) => {
    logger.warn("Agent socket connect_error", { error: err.message });
  });

  agentSocket.on("agent:typing", (payload: AgentTypingPayload) => {
    void handleAgentTyping(payload);
  });

  agentSocket.on("agent:reply", (payload: AgentReplyPayload) => {
    void handleAgentReply(payload);
  });
}

async function handleAgentTyping(payload: AgentTypingPayload): Promise<void> {
  const { userId, groupId, singleChatId } = payload;

  if (!groupId && !singleChatId) return;

  const conversationId = groupId ?? singleChatId!;
  const conversationType: "group" | "single" = groupId ? "group" : "single";

  const browserIO = getIO();
  const typingPayload = { conversationId, conversationType };

  if (groupId) {
    try {
      const members = await GroupMember.findAll({
        where: { groupId },
        attributes: ["userId"],
      });
      for (const m of members) {
        browserIO.to(`user:${m.userId}`).emit("thread:typing", typingPayload);
      }
    } catch {
      browserIO.to(`user:${userId}`).emit("thread:typing", typingPayload);
    }
  } else {
    browserIO.to(`user:${userId}`).emit("thread:typing", typingPayload);
  }
}

async function handleAgentReply(payload: AgentReplyPayload): Promise<void> {
  const {
    requestId,
    userId,
    threadId,
    groupId,
    singleChatId,
  } = payload;

  if (!groupId && !singleChatId) return;

  const conversationId = groupId ?? singleChatId!;
  const conversationType: "group" | "single" = groupId ? "group" : "single";

  const clientPayload: ChatReplyToClient = {
    requestId,
    threadId,
    groupId,
    singleChatId,
    conversationId,
    conversationType,
    ok: payload.ok,
    ...(payload.ok
      ? {
          reply: payload.reply,
          systemPrompt: payload.systemPrompt,
          ...(payload.modelSlug ? { modelSlug: payload.modelSlug } : {}),
          ...(payload.vendorSlug ? { vendorSlug: payload.vendorSlug } : {}),
          ...(payload.modelName ? { modelName: payload.modelName } : {}),
        }
      : { error: payload.error }),
  };

  const preview = payload.ok
    ? payload.reply.slice(0, 200)
    : `Error: ${payload.error}`.slice(0, 300);

  logger.info("Received agent reply, fanning out", { requestId, threadId, conversationType, conversationId, ok: payload.ok });

  const browserIO = getIO();

  if (groupId) {
    // Fan out to all group members
    try {
      const members = await GroupMember.findAll({
        where: { groupId },
        attributes: ["userId"],
      });

      const recipientIds = members.map((m) => m.userId);

      // Create notifications BEFORE emitting to browsers so that when a client
      // immediately responds with `message:seen`, the row already exists in the DB.
      for (const recipientId of recipientIds) {
        if (recipientId !== userId) {
          await MessageNotification.create({
            threadId,
            recipientId,
            senderId: null,
            messageId: requestId,
            preview: preview ?? null,
            status: "delivered",
            conversationId: groupId,
            conversationType: "group",
          });
        }
      }

      // Notify the sender on assistant errors so unread/badge appears if they are elsewhere (e.g. Admin).
      if (!payload.ok) {
        try {
          await MessageNotification.create({
            threadId,
            recipientId: userId,
            senderId: null,
            messageId: requestId,
            preview: preview ?? null,
            status: "delivered",
            conversationId: groupId,
            conversationType: "group",
          });
        } catch (err) {
          logger.error("Group error notification create", { error: String(err) });
        }
      }

      for (const recipientId of recipientIds) {
        browserIO.to(`user:${recipientId}`).emit("chat:reply", clientPayload);
      }
    } catch (err) {
      logger.error("Group fan-out error", { groupId, error: String(err) });
      browserIO.to(`user:${userId}`).emit("chat:reply", clientPayload);
    }
  } else {
    // Single chat: create notification BEFORE emitting so that the client's
    // immediate `message:seen` response can find and update the row.
    // Include assistant errors so the sidebar unread badge updates when the user is not in chat.
    try {
      await MessageNotification.create({
        threadId,
        recipientId: userId,
        senderId: null,
        messageId: requestId,
        preview: preview ?? null,
        status: "delivered",
        conversationId: singleChatId ?? threadId,
        conversationType: "single",
      });
    } catch (err) {
      logger.error("Notification create error", { threadId, error: String(err) });
    }

    browserIO.to(`user:${userId}`).emit("chat:reply", clientPayload);
  }
}

export function disconnectFromAgentService(): void {
  agentSocket?.disconnect();
  agentSocket = null;
}
