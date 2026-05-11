import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { logger } from "./logger";
import {
  askGrahamyClassifyRequestSchema,
  askGrahamyRequestSchema,
} from "./askGrahamy/types";
import {
  classifyAskGrahamy,
  runAskGrahamyForExternalUser,
} from "./services/askGrahamy.service";

/**
 * Ask-Grahamy socket bridge for StocksScanner (and any other application
 * caller). Sibling to `attachAgentSocketIO` (`socket.ts`) — different
 * namespace path, different consumer, different events.
 *
 * Why this exists: the legacy `POST /api/ask-grahamy` + `POST /api/ask-grahamy/classify`
 * pair is two synchronous HTTP calls per turn. Each can take 30-900s and
 * each idle TCP path between agent_service and SS (CDN/nginx/proxy/etc.)
 * happily closes the connection at the 60-100s mark. SS then sees a cut
 * stream even when agent_service is healthy and would have finished
 * fine. A long-lived socket replaces both round-trips with messages over
 * an already-open connection — no per-call HTTP handshake, no
 * intermediary idle timeout, no axios `ECONNRESET` mid-graph.
 *
 * Protocol (socket.io ack-callback style — request → response):
 *   `ask:classify` payload: AskGrahamyClassifyRequest
 *                  ack:    { ok: true, response } | { ok: false, status, error }
 *   `ask:run`     payload: AskGrahamyRequest
 *                  ack:    { ok: true, response } | { ok: false, status, error }
 *
 * Auth: `handshake.auth.token` must equal `APPLICATION_AGENT_API_TOKEN`
 * (same shared secret the HTTP `requireApplicationToken` middleware
 * checks). Connections without a matching token are dropped during the
 * handshake — the namespace never sees an unauthenticated socket.
 */

const NAMESPACE_PATH = "/ask-bridge";
const SOCKET_IO_PATH = "/agent-socket";

let bridgeIO: Server | null = null;

export function getAskBridgeIO(): Server {
  if (!bridgeIO) {
    throw new Error("Ask-bridge Socket.IO has not been initialized");
  }
  return bridgeIO;
}

/**
 * Attaches the `/ask-bridge` namespace to a Socket.IO server. Pass an
 * EXISTING Server instance (returned by `attachAgentSocketIO`) so both
 * the `user_app` `/agent-socket` namespace and this `/ask-bridge`
 * namespace share one HTTP server, one engine.io path, one CORS config.
 * Calling `new Server(httpServer)` twice on the same path will silently
 * shadow handlers, which is why we plumb the existing instance in.
 */
export function attachAskBridgeSocketIO(io: Server): Server {
  const ns = io.of(NAMESPACE_PATH);

  ns.use((socket, next) => {
    const expected = process.env.APPLICATION_AGENT_API_TOKEN;
    if (!expected || expected.trim().length === 0) {
      // Fail-closed identical to the HTTP middleware. If the secret is
      // not configured, refuse every connection — beats accidental
      // public exposure if the operator forgot the env var.
      logger.warn("ask-bridge: refused connection — APPLICATION_AGENT_API_TOKEN not set");
      return next(new Error("Unauthorized"));
    }
    const provided = (socket.handshake.auth as { token?: string } | undefined)
      ?.token;
    if (typeof provided !== "string" || provided !== expected) {
      logger.warn("ask-bridge: refused connection — token mismatch", {
        socketId: socket.id,
      });
      return next(new Error("Unauthorized"));
    }
    next();
  });

  ns.on("connection", (socket: Socket) => {
    logger.info("ask-bridge: client connected", { socketId: socket.id });

    socket.on(
      "ask:classify",
      async (payload: unknown, ack?: (response: unknown) => void) => {
        if (typeof ack !== "function") {
          // The bridge is strictly request/response — a missing ack
          // means the caller can't receive the reply, so drop the
          // event. We still log so a buggy caller is visible.
          logger.warn("ask-bridge: ask:classify received with no ack");
          return;
        }
        const parsed = askGrahamyClassifyRequestSchema.safeParse(payload ?? {});
        if (!parsed.success) {
          ack({
            ok: false,
            status: 400,
            error:
              "Invalid classify payload — userId and non-empty message are required.",
          });
          return;
        }
        try {
          const result = await classifyAskGrahamy(parsed.data);
          if (!result.ok) {
            ack({ ok: false, status: result.status, error: result.error });
            return;
          }
          ack({ ok: true, response: result.response });
        } catch (err) {
          logger.error("ask-bridge: ask:classify handler crashed", {
            error: err instanceof Error ? err.message : String(err),
          });
          ack({
            ok: false,
            status: 500,
            error: err instanceof Error ? err.message : "classify failed",
          });
        }
      },
    );

    socket.on(
      "ask:run",
      async (payload: unknown, ack?: (response: unknown) => void) => {
        if (typeof ack !== "function") {
          logger.warn("ask-bridge: ask:run received with no ack");
          return;
        }
        // `turnId` is bridge-level metadata, not part of the
        // AskGrahamyRequest schema. SS includes it so the progress
        // emit fan-out can be routed back to the right user-room
        // turn. Pop it before zod validation; zod would strip it
        // anyway (`z.object` defaults to strip-unknown), but pulling
        // it explicitly makes intent clear and keeps the type narrow.
        const rawPayload =
          payload && typeof payload === "object"
            ? (payload as Record<string, unknown>)
            : {};
        const turnId =
          typeof rawPayload.turnId === "string" ? rawPayload.turnId : undefined;
        const { turnId: _stripped, ...requestBody } = rawPayload;
        void _stripped;
        const parsed = askGrahamyRequestSchema.safeParse(requestBody);
        if (!parsed.success) {
          ack({
            ok: false,
            status: 400,
            error:
              "Invalid run payload — userId, message, and classification are required.",
          });
          return;
        }
        try {
          // If the caller gave us a turnId, every coarse stage boundary
          // travels back as a separate `ask:run-progress` event over
          // the SAME socket. That's why we don't need a parallel SSE
          // channel any more — one socket, one ack for the final
          // response, N progress emits in between.
          const result = await runAskGrahamyForExternalUser(parsed.data, {
            emitProgress: turnId
              ? (event) => {
                  socket.emit("ask:run-progress", { turnId, ...event });
                }
              : undefined,
          });
          if (!result.ok) {
            ack({ ok: false, status: result.status, error: result.error });
            return;
          }
          ack({ ok: true, response: result.response });
        } catch (err) {
          logger.error("ask-bridge: ask:run handler crashed", {
            error: err instanceof Error ? err.message : String(err),
          });
          ack({
            ok: false,
            status: 500,
            error: err instanceof Error ? err.message : "run failed",
          });
        }
      },
    );

    socket.on("disconnect", (reason) => {
      logger.info("ask-bridge: client disconnected", {
        socketId: socket.id,
        reason,
      });
    });
  });

  bridgeIO = io;
  logger.info("ask-bridge: namespace attached", {
    namespace: NAMESPACE_PATH,
    enginePath: SOCKET_IO_PATH,
  });
  return io;
}
