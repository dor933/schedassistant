import "dotenv/config";
import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import path from "path";
import { sequelize } from "@scheduling-agent/database";
import { authRouter } from "./routes/auth.routes";
import { chatRouter } from "./routes/chat.routes";
import { sessionsRouter } from "./routes/sessions.routes";
import { notificationsRouter } from "./routes/notifications.routes";
import { adminRouter } from "./routes/admin/index";
import { attachSocketIO } from "./sockets/server/socketServer";
import { connectToAgentService } from "./sockets/client/socketClient";
import { logger } from "./logger";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

/** App is always mounted under `/claw` (must match client `VITE_APP_URL_PREFIX`). */
const APP_URL_PREFIX = "/claw";

async function main(): Promise<void> {
  logger.info("Starting user_app…");

  await sequelize.authenticate();
  logger.info("Database connection OK");

  const app = express();

  app.use(cors());
  app.use(express.json());

  // Strip `/claw` for Express routes — but NOT for Socket.IO, which is registered at
  // `${APP_URL_PREFIX}/socket.io` (see `attachSocketIO`). Rewriting `/claw/socket.io` → `/socket.io`
  // breaks path matching and WebSockets never connect (works in dev if proxy masks this).
  const socketIoUrlPrefix = `${APP_URL_PREFIX}/socket.io`;
  app.use((req, res, next) => {
    const url = req.url;
    if (url.startsWith(socketIoUrlPrefix)) {
      return next();
    }
    if (url === APP_URL_PREFIX || url.startsWith(`${APP_URL_PREFIX}/`) || url.startsWith(`${APP_URL_PREFIX}?`)) {
      req.url = url.slice(APP_URL_PREFIX.length) || "/";
    }
    next();
  });

  app.use("/api/auth", authRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/sessions", sessionsRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/admin", adminRouter);

  const clientDist = path.join(__dirname, "..", "client", "dist");
  app.use(express.static(clientDist));

  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) {
      return next();
    }
    // Do not serve SPA HTML for Socket.IO polling / upgrade — same path as `attachSocketIO` `path` option.
    if (req.path.startsWith(`${APP_URL_PREFIX}/socket.io`)) {
      return next();
    }
    res.sendFile(path.join(clientDist, "index.html"));
  });

  // Attach Socket.IO before Express so Engine handles `/claw/socket.io` first. With `createServer(app)`,
  // Express ran first and could answer GET `/claw/socket.io` with `index.html` (SPA fallback), breaking handshakes.
  const httpServer = createServer();
  attachSocketIO(httpServer, APP_URL_PREFIX);
  httpServer.on("request", app);

  connectToAgentService();

  httpServer.listen(PORT, () => {
    logger.info(`Listening on port ${PORT} (HTTP + Socket.IO), app prefix "${APP_URL_PREFIX}"`);
  });
}

main().catch((err) => {
  logger.error("Fatal startup error", { error: String(err) });
  process.exit(1);
});
