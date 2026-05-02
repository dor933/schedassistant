import express from "express";
import cors from "cors";
import type { Queue } from "bullmq";
import type { AgentChatJobData, AgentChatJobResult } from "./queues/agentChat.bull";
import type { CompiledStateGraph } from "@langchain/langgraph";
import { setDeps } from "./deps";
import { chatRouter } from "./routes/chat.routes";
import { sessionsRouter } from "./routes/sessions.routes";
import { historyRouter } from "./routes/history.routes";
import { epicTaskRouter } from "./routes/epicTask.routes";
import { repositoriesRouter } from "./routes/repositories.routes";
import { roundtableRouter } from "./routes/roundtable.routes";
import { libraryRouter } from "./routes/library.routes";
import { attachmentsRouter } from "./routes/attachments.routes";
import { systemRouter } from "./routes/system.routes";
import { applicationRouter } from "./routes/application.routes";
import { askGrahamyRouter } from "./routes/askGrahamy.routes";
import { internalRouter } from "./routes/internal.routes";

export type CreateServerDeps = {
  agentChatQueue: Queue<AgentChatJobData, AgentChatJobResult, string>;
  graph: CompiledStateGraph<any, any, any>;
  roundtableGraph: CompiledStateGraph<any, any, any>;
  applicationGraph: CompiledStateGraph<any, any, any>;
};

/**
 * Creates and returns the Express app for agent_service.
 * Chat requests are enqueued on `agentChatQueue`; the worker emits results via Socket.IO.
 */
export function createServer(deps: CreateServerDeps) {
  setDeps(deps);

  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use("/api/chat", chatRouter);
  app.use("/api/sessions", sessionsRouter);
  app.use("/api/history", historyRouter);
  app.use("/api/epics", epicTaskRouter);
  app.use("/api/repositories", repositoriesRouter);
  app.use("/api/roundtable", roundtableRouter);
  app.use("/api/library", libraryRouter);
  app.use("/api/attachments", attachmentsRouter);
  app.use("/api/system", systemRouter);
  app.use("/api/application", applicationRouter);
  app.use("/api/ask-grahamy", askGrahamyRouter);

  // Service-to-service: mounted at /internal so it's distinct from every
  // browser-reachable /api surface. Only mcp_server should ever hit this,
  // authenticated by per-turn JWT (see codexBridgeAuth + InternalToolsController).
  app.use("/internal", internalRouter);

  return app;
}
