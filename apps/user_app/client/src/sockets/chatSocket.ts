import { io, type Socket } from "socket.io-client";

/** Mirrors the payload emitted by user_app server on `chat:reply`. */
export type ChatReplyPayload =
  | {
      requestId: string;
      threadId: string;
      groupId: string | null;
      singleChatId: string | null;
      conversationId: string;
      conversationType: "group" | "single";
      ok: true;
      reply: string;
      systemPrompt: string | null;
    }
  | {
      requestId: string;
      threadId: string;
      groupId: string | null;
      singleChatId: string | null;
      conversationId: string;
      conversationType: "group" | "single";
      ok: false;
      error: string;
    };

let socket: Socket | null = null;

/**
 * Singleton Socket.IO client (same origin in dev via Vite proxy).
 * Authenticates with JWT in the handshake (`auth.token`).
 */
export function getChatSocket(token: string): Socket {
  if (socket?.connected) {
    socket.auth = { token };
    return socket;
  }

  socket = io({
    path: "/claw/socket.io",
    auth: { token },
    transports: ["websocket", "polling"],
    autoConnect: true,
  });

  socket.on("connect_error", (err) => {
    console.warn("[chatSocket] connect_error:", err.message);
  });

  return socket;
}

/** Tells the server that the user has seen all messages in a conversation. */
export function markConversationSeen(
  conversationId: string,
  conversationType: "group" | "single",
): void {
  socket?.emit("message:seen", { conversationId, conversationType });
}

/** Tells the server that the current user is typing in a group conversation. */
export function emitUserTyping(groupId: string): void {
  socket?.emit("user:typing", { groupId });
}

export function disconnectChatSocket(): void {
  socket?.disconnect();
  socket = null;
}
