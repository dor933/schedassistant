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

export type CreateServerDeps = {
  agentChatQueue: Queue<AgentChatJobData, AgentChatJobResult, string>;
  graph: CompiledStateGraph<any, any, any>;
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

  return app;
}
