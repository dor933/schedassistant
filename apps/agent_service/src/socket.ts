import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { logger } from "./logger";

let ioInstance: Server | null = null;

export function getAgentIO(): Server {
  if (!ioInstance) {
    throw new Error("Agent Socket.IO has not been initialized");
  }
  return ioInstance;
}

/**
 * Payload emitted by the agent worker when a chat turn completes.
 * `user_app` listens on `agent:reply`.
 */
export interface AgentReplyPayload {
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

export interface AgentErrorPayload {
  requestId: string;
  userId: number;
  threadId: string;
  groupId: string | null;
  singleChatId: string | null;
  ok: false;
  error: string;
}

export type AgentChatPayload = AgentReplyPayload | AgentErrorPayload;

/** Emitted when the worker starts processing a job. */
export interface AgentTypingPayload {
  threadId: string;
  userId: number;
  groupId: string | null;
  singleChatId: string | null;
}

/**
 * Attaches a Socket.IO server to the agent_service HTTP server.
 * The only expected client is `user_app` (internal service-to-service).
 * No JWT auth — secured by Docker network / internal connectivity.
 */
export function attachAgentSocketIO(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    path: "/agent-socket",
    cors: { origin: true },
  });

  io.on("connection", (socket) => {
    logger.info("user_app socket connected", { socketId: socket.id });
    socket.on("disconnect", () => {
      logger.info("user_app socket disconnected", { socketId: socket.id });
    });
  });

  ioInstance = io;
  return io;
}

/**
 * Emits a typing indicator when the worker starts processing a job.
 */
export function emitAgentTyping(payload: AgentTypingPayload): void {
  const io = ioInstance;
  if (!io) return;
  io.emit("agent:typing", payload);
}

/**
 * Emits a chat result to all connected user_app instances.
 */
export function emitAgentReply(payload: AgentChatPayload): void {
  const io = ioInstance;
  if (!io) {
    logger.warn("Cannot emit agent:reply — socket not initialized");
    return;
  }
  io.emit("agent:reply", payload);
}
