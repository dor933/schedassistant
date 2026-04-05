/**
 * Entry point for the agent_service container.
 *
 * Initialises the PostgreSQL connection, starts the BullMQ deep-agent worker,
 * and boots the Express HTTP + Socket.IO server on port 3001.
 */

import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { sequelize, Agent } from "@scheduling-agent/database";
import { createServer } from "./server";
import { initializeLangfuse, isLangfuseConfigured, shutdownLangfuse } from "./langfuse";
import {
  agentChatQueue,
  agentChatQueueEvents,
} from "./queues/agentChat.bull";
import { startDeepAgentWorker } from "./worker/deepAgent.worker";
import { attachAgentSocketIO } from "./socket";
import { logger } from "./logger";

const PORT = parseInt(process.env.PORT ?? "3001", 10);

async function main(): Promise<void> {
  logger.info("Starting agent_service…");

  if (isLangfuseConfigured()) {
    try {
      initializeLangfuse();
      logger.info("Langfuse observability enabled");
    } catch (err) {
      logger.warn("Langfuse init failed (continuing without)", { error: String(err) });
    }
  } else {
    logger.info("Langfuse not configured (set LANGFUSE_SECRET_KEY + LANGFUSE_PUBLIC_KEY to enable)");
  }

  // 1. Verify database connectivity.
  await sequelize.authenticate();
  logger.info("Database connection OK");

  // 1b. Ensure workspace directories exist for every agent (used by workspace_* tools).
  try {
    const agents = await Agent.findAll({ attributes: ["id", "workspacePath"] });
    for (const agent of agents) {
      if (agent.workspacePath) {
        fs.mkdirSync(agent.workspacePath, { recursive: true });
      }
    }
    logger.info("Agent workspace directories verified", { count: agents.length });
  } catch (err) {
    logger.warn("Failed to verify workspace directories", { error: String(err) });
  }

  // 2. BullMQ: queue events + deep agent worker (main chat executor).
  await agentChatQueueEvents.waitUntilReady();
  const deepAgentWorker = startDeepAgentWorker();

  // 3. HTTP + Socket.IO server (chat enqueues jobs; results emitted via socket).
  const app = createServer({ agentChatQueue });
  const httpServer = createHttpServer(app);
  attachAgentSocketIO(httpServer);

  httpServer.listen(PORT, () => {
    logger.info(`HTTP + Socket.IO server listening on port ${PORT}`);
  });
  const server = httpServer;

  const stop = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down…`);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    try {
      await deepAgentWorker.close();
      await agentChatQueue.close();
      await agentChatQueueEvents.close();
      await shutdownLangfuse();
      await sequelize.close();
    } catch (e) {
      logger.error("Shutdown error", { error: String(e) });
    }
    process.exit(0);
  };

  process.once("SIGTERM", () => {
    void stop("SIGTERM");
  });
  process.once("SIGINT", () => {
    void stop("SIGINT");
  });
}

main().catch((err) => {
  logger.error("Fatal startup error", { error: String(err) });
  process.exit(1);
});
