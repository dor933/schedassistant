import type { Queue } from "bullmq";
import type { AgentChatJobData, AgentChatJobResult } from "./queues/agentChat.bull";
import type { CompiledStateGraph } from "@langchain/langgraph";

let _agentChatQueue: Queue<AgentChatJobData, AgentChatJobResult, string>;
let _graph: CompiledStateGraph<any, any, any>;
let _roundtableGraph: CompiledStateGraph<any, any, any> | null = null;

export function setDeps(deps: {
  agentChatQueue: Queue<AgentChatJobData, AgentChatJobResult, string>;
  graph: CompiledStateGraph<any, any, any>;
  roundtableGraph?: CompiledStateGraph<any, any, any>;
}) {
  _agentChatQueue = deps.agentChatQueue;
  _graph = deps.graph;
  if (deps.roundtableGraph) _roundtableGraph = deps.roundtableGraph;
}

export function getAgentChatQueue() {
  return _agentChatQueue;
}

export function getGraph() {
  return _graph;
}

export function getRoundtableGraph() {
  if (!_roundtableGraph) {
    throw new Error("Roundtable graph has not been initialized");
  }
  return _roundtableGraph;
}
