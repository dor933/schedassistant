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

async function main(): Promise<void> {
  logger.info("Starting user_app…");

  await sequelize.authenticate();
  logger.info("Database connection OK");

  const app = express();

  app.use(cors());
  app.use(express.json());

  // API routes
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
  attachSocketIO(httpServer);

  connectToAgentService();

  httpServer.listen(PORT, () => {
    logger.info(`Listening on port ${PORT} (HTTP + Socket.IO)`);
  });
}

main().catch((err) => {
  logger.error("Fatal startup error", { error: String(err) });
  process.exit(1);
});
