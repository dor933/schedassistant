/**
 * Entry point for the agent_service container.
 *
 * Initialises the PostgreSQL connection, runs the LangGraph Postgres
 * checkpointer setup, compiles the LangGraph agent with persistence,
 * and starts an Express HTTP server on port 3001.
 */

import { createServer as createHttpServer } from "node:http";
import { sequelize } from "@scheduling-agent/database";
import { createSchedulerGraph } from "./graphs/basicGraph/index";
import { createServer } from "./server";
import { initializeLangfuse, isLangfuseConfigured, shutdownLangfuse } from "./langfuse";
import {
  agentChatQueue,
  agentChatQueueEvents,
} from "./queues/agentChat.bull";
import {
  deepAgentQueueEvents,
} from "./queues/deepAgent.bull";
import { startAgentChatWorker } from "./worker/agentChat.worker";
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

  // 2. Create checkpointer + compile graph with Postgres persistence.
  // Chat turns (worker → executeChatTurn) pass `agentId` in graph state; contextBuilder
  // loads `agents.core_instructions` from the DB and merges them into the system prompt.
  const graph = await createSchedulerGraph();
  logger.info("Agent graph compiled with PostgresSaver checkpointer");

  // 3. BullMQ: queue events + workers.
  await agentChatQueueEvents.waitUntilReady();
  await deepAgentQueueEvents.waitUntilReady();
  const agentChatWorker = startAgentChatWorker(graph);
  const deepAgentWorker = startDeepAgentWorker();

  // 4. HTTP + Socket.IO server (chat enqueues jobs; results emitted via socket).
  const app = createServer({ agentChatQueue, graph });
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
      await agentChatWorker.close();
      await deepAgentWorker.close();
      await agentChatQueue.close();
      await agentChatQueueEvents.close();
      await deepAgentQueueEvents.close();
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
