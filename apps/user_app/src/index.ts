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

  app.use((req, res, next) => {
    const url = req.url;
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
    res.sendFile(path.join(clientDist, "index.html"));
  });

  const httpServer = createServer(app);
  attachSocketIO(httpServer, APP_URL_PREFIX);

  connectToAgentService();

  httpServer.listen(PORT, () => {
    logger.info(`Listening on port ${PORT} (HTTP + Socket.IO), app prefix "${APP_URL_PREFIX}"`);
  });
}

main().catch((err) => {
  logger.error("Fatal startup error", { error: String(err) });
  process.exit(1);
});
