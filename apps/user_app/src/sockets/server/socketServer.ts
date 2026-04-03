import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { verifyToken } from "../../middlewares/auth";
import { MessageNotification, GroupMember, User } from "@scheduling-agent/database";
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
export function attachSocketIO(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    path: "/socket.io",
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
            const isRelevant = entry.groupId || entry.userId === userId;
            if (!isRelevant) continue;
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

    // ── user:typing — fan out typing indicator to other group members ──
    socket.on("user:typing", async (data: { groupId: string }) => {
      try {
        const members = await GroupMember.findAll({
          where: { groupId: data.groupId },
          attributes: ["userId"],
        });
        const user = await User.findByPk(userId, { attributes: ["displayName"] });
        const displayName = user?.displayName ?? userId;

        for (const m of members) {
          if (m.userId === userId) continue;
          io.to(`user:${m.userId}`).emit("user:typing", {
            groupId: data.groupId,
            userId,
            displayName,
          });
        }
      } catch (err) {
        logger.error("user:typing handler error", { userId, error: String(err) });
      }
    });

    // ── message:seen — client confirms the user has seen messages in a conversation ──
    socket.on(
      "message:seen",
      async (data: { conversationId: string; conversationType: "group" | "single" }) => {
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
