import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { verifyToken } from "../../middlewares/auth";
import { MessageNotification } from "@scheduling-agent/database";
import { logger } from "../../logger";
import { fetchActiveJobs } from "../client/socketClient";

let ioInstance: Server | null = null;

export function getIO(): Server {
  if (!ioInstance) {
    throw new Error("Socket.IO has not been initialized");
  }
  return ioInstance;
}

/**
 * Attaches Socket.IO to the shared HTTP server (same port as Express).
 * Clients authenticate with `socket.io-client` using `auth: { token }` (JWT).
 */
export function attachSocketIO(httpServer: HttpServer, appUrlPrefix = ""): Server {
  const socketPath = appUrlPrefix ? `${appUrlPrefix}/socket.io` : "/socket.io";
  const io = new Server(httpServer, {
    path: socketPath,
    cors: {
      origin: true,
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const raw = socket.handshake.auth.token;
    const token = typeof raw === "string" ? raw : undefined;
    if (!token) {
      return next(new Error("Unauthorized: missing token"));
    }
    const user = verifyToken(token);
    if (!user) {
      return next(new Error("Unauthorized: invalid token"));
    }
    socket.data.userId = user.userId;
    return next();
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId as number;
    void socket.join(`user:${userId}`);

    const emitActiveJobTyping = () => {
      fetchActiveJobs()
        .then((jobs) => {
          for (const entry of jobs) {
            if (entry.userId !== userId) continue;
            socket.emit("thread:typing", {
              conversationId: entry.conversationId,
              conversationType: entry.conversationType,
            });
          }
        })
        .catch((err) => {
          logger.warn("Failed to fetch active jobs", { userId, error: String(err) });
        });
    };

    // Query agent_service for jobs still in progress and re-emit typing indicators
    emitActiveJobTyping();

    // Client can request the same sync when returning to the chat UI (e.g. from Admin)
    // without reconnecting the socket.
    socket.on("sync:active-typing", () => {
      emitActiveJobTyping();
    });

    // ── message:seen — client confirms the user has seen messages in a conversation ──
    socket.on(
      "message:seen",
      async (data: { conversationId: string; conversationType: "single" }) => {
        try {
          await MessageNotification.update(
            { status: "seen", seenAt: new Date() },
            {
              where: {
                recipientId: userId,
                conversationId: data.conversationId,
                conversationType: data.conversationType,
                status: "delivered",
              },
            },
          );
        } catch (err) {
          logger.error("message:seen handler error", { userId, error: String(err) });
        }
      },
    );
  });

  ioInstance = io;
  return io;
}
