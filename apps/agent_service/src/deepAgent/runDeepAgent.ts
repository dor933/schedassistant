import { createDeepAgent } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  Agent,
  Employee,
  LLMModel,
  Person,
  Vendor,
} from "@scheduling-agent/database";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogle } from "@langchain/google";
import { ChatAnthropic } from "@langchain/anthropic";
import { getLangfuseCallbackHandler, flushLangfuse } from "../langfuse";
import { logger } from "../logger";

/**
 * Shared helpers for spinning up a `deepagents` deep-agent instance from an
 * `agents` row in the database. Used by both the main chat worker and the
 * `consult_agent` tool so they resolve models / build prompts the same way.
 */

export type ResolvedModel = {
  chat: ChatOpenAI | ChatAnthropic | ChatGoogle;
  vendorSlug: string;
  modelName: string;
  modelSlug: string;
};

/** Resolves a LangChain chat model instance from a model slug using the DB vendor row. */
export async function resolveModelBySlug(
  modelSlug: string,
): Promise<ResolvedModel | null> {
  const model = await LLMModel.findOne({
    where: { slug: modelSlug },
    attributes: ["id", "name", "vendorId"],
  });
  if (!model) return null;
  const vendor = await Vendor.findByPk(model.vendorId, {
    attributes: ["slug", "apiKey"],
  });
  if (!vendor?.apiKey) return null;

  switch (vendor.slug) {
    case "anthropic":
      return {
        chat: new ChatAnthropic({
          modelName: modelSlug,
          temperature: 0.4,
          apiKey: vendor.apiKey,
          ...(process.env.MERIDIAN_URL
            ? { anthropicApiUrl: process.env.MERIDIAN_URL }
            : {}),
        }),
        vendorSlug: "anthropic",
        modelName: model.name,
        modelSlug,
      };
    case "openai":
      return {
        chat: new ChatOpenAI({
          modelName: modelSlug,
          temperature: 0.4,
          apiKey: vendor.apiKey,
        }),
        vendorSlug: "openai",
        modelName: model.name,
        modelSlug,
      };
    case "google":
      return {
        chat: new ChatGoogle({
          model: modelSlug,
          temperature: 0.4,
          apiKey: vendor.apiKey,
        }),
        vendorSlug: "google",
        modelName: model.name,
        modelSlug,
      };
    default:
      return null;
  }
}

/** Resolves the agent's configured model (falling back to `gpt-4o`). */
export async function resolveAgentModel(agent: Agent): Promise<ResolvedModel> {
  let modelSlug = "gpt-4o";
  if (agent.modelId) {
    const m = await LLMModel.findByPk(agent.modelId, { attributes: ["slug"] });
    if (m?.slug) modelSlug = m.slug;
  }
  const resolved = await resolveModelBySlug(modelSlug);
  if (!resolved) {
    throw new Error(
      `Cannot resolve model "${modelSlug}" — vendor API key missing or unknown vendor.`,
    );
  }
  return resolved;
}

/**
 * Looks up the current user and returns a "## Current user" section the
 * prompt builder can splice in. Recognises three cases:
 *
 *  - person + employee row   → "…X is an employee of the company."
 *  - person only             → "…X."
 *  - no person row for this id → `null` (caller omits the section entirely)
 */
export async function buildCurrentUserSection(
  userId: number,
): Promise<string | null> {
  try {
    const person = await Person.findByPk(userId, {
      attributes: ["id", "firstName", "lastName"],
    });
    if (!person) return null;

    const name =
      [person.firstName, person.lastName]
        .map((p) => (p ?? "").trim())
        .filter(Boolean)
        .join(" ") || `User ${userId}`;

    const employee = await Employee.findByPk(userId, { attributes: ["id"] });
    const isEmployee = !!employee;

    if (isEmployee) {
      return (
        `## Current user\n` +
        `The user chatting with you is **${name}**, an employee of the company.`
      );
    }
    return `## Current user\nThe user chatting with you is **${name}**.`;
  } catch (err) {
    logger.warn("buildCurrentUserSection failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Builds a compact system prompt from the agent's configuration.
 * Mirrors what the chat worker uses so peer-agent consultations see the same persona.
 *
 * When `opts.userId` is provided, appends a `## Current user` section that
 * identifies the person at the keyboard and flags whether they are a company
 * employee (via the `employees` table).
 */
export async function buildAgentSystemPrompt(
  agent: Agent,
  opts?: { userId?: number },
): Promise<string> {
  const sections: string[] = [];
  if (agent.agentName) sections.push(`## Your name is ${agent.agentName}`);

  const role = agent.definition?.trim() || "AI assistant";
  sections.push(`You are a ${role}.`);

  if (agent.coreInstructions?.trim()) {
    sections.push("## Instructions");
    sections.push(agent.coreInstructions);
  }

  if (
    agent.characteristics &&
    typeof agent.characteristics === "object" &&
    !Array.isArray(agent.characteristics) &&
    Object.keys(agent.characteristics).length > 0
  ) {
    const lines: string[] = ["## Your characteristics"];
    for (const [key, value] of Object.entries(agent.characteristics)) {
      if (value === undefined || value === null) continue;
      const formatted =
        typeof value === "object" ? JSON.stringify(value) : String(value);
      lines.push(`- **${key}:** ${formatted}`);
    }
    if (lines.length > 1) sections.push(lines.join("\n"));
  }

  if (agent.agentNotes?.trim()) {
    sections.push("## Agent notes");
    sections.push(agent.agentNotes);
  }

  sections.push(
    "## Long-term memory",
    "You have a persistent vector store scoped to you. Use `save_memory` to remember " +
      "facts, preferences, decisions, or context that you'll want across future conversations. " +
      "Use `search_memory` when the user asks about something that might have been stored earlier, " +
      "or when you need context from prior sessions. Keep each saved memory self-contained.",
  );

  if (agent.workspacePath) {
    sections.push(
      "## Workspace files",
      "You have a persistent workspace folder where you can store, read, and edit `.md` and `.txt` files. " +
        "These files persist across all conversations and are private to you.\n\n" +
        "Available tools: `workspace_list_files`, `workspace_read_file`, `workspace_write_file`, " +
        "`workspace_edit_file`, `workspace_delete_file`.",
    );
  }

  sections.push(
    "## Agent notes tools",
    "Your free-form notes — important information you've chosen to remember (pending tasks, follow-ups, " +
      "project details, user preferences, etc.). Use `read_agent_notes` to read them, `append_agent_notes` " +
      "to add new entries, and `edit_agent_notes` to correct, reorganize, or remove completed items.",
  );

  sections.push(
    "## Peer agents",
    "You can talk to other agents in the system. Use `list_agents` to discover which agents exist " +
      "(everyone except yourself), then `consult_agent` with the target agent's ID to send them a request " +
      "and receive their answer synchronously. Useful when a task falls outside your specialization and " +
      "another agent is better equipped to handle it.",
  );

  if (opts?.userId != null) {
    const userSection = await buildCurrentUserSection(opts.userId);
    if (userSection) sections.push(userSection);
  }

  return sections.join("\n\n");
}

/** Extracts the final assistant reply from a LangGraph `messages` array. */
export function extractReply(messages: any[]): string {
  const lastAi = [...messages]
    .reverse()
    .find(
      (m: any) =>
        (typeof m._getType === "function" && m._getType() === "ai") ||
        m.role === "assistant",
    );

  const rawContent = lastAi?.content;
  if (rawContent == null) return "The agent did not produce a response.";
  if (typeof rawContent === "string") return rawContent;
  if (Array.isArray(rawContent)) {
    return (
      rawContent
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("\n") || "The agent did not produce a text response."
    );
  }
  return JSON.stringify(rawContent);
}

/**
 * One-shot deep-agent invocation for an in-process consultation (e.g. `consult_agent`).
 * Uses an ephemeral `MemorySaver` — the consulted agent gets its persona and tools
 * but no persistent checkpoint memory for this call.
 */
export async function invokeDeepAgentOneShot(params: {
  agent: Agent;
  tools: StructuredToolInterface[];
  userId: number;
  userMessage: string;
  systemPrompt?: string;
  timeoutMs?: number;
  recursionLimit?: number;
}): Promise<{ reply: string; modelSlug: string; vendorSlug: string; modelName: string }> {
  const {
    agent,
    tools,
    userId,
    userMessage,
    systemPrompt,
    timeoutMs = 5 * 60 * 1000,
    recursionLimit = 40,
  } = params;

  const resolved = await resolveAgentModel(agent);
  const prompt = systemPrompt ?? (await buildAgentSystemPrompt(agent, { userId }));

  const checkpointer: BaseCheckpointSaver = new MemorySaver();
  const deepAgent = createDeepAgent({
    model: resolved.chat as any,
    tools: tools as any[],
    systemPrompt: prompt,
    checkpointer,
  });

  const langfuseHandler = getLangfuseCallbackHandler(userId, {
    agentId: agent.id,
    service: "deep_agent_oneshot",
  });
  const traced = langfuseHandler
    ? deepAgent.withConfig({ callbacks: [langfuseHandler] })
    : deepAgent;

  const runThreadId = `oneshot-${agent.id}-${Date.now()}`;
  const timer = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Deep agent one-shot timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );
  });

  try {
    const result = (await Promise.race([
      traced.invoke(
        { messages: [{ role: "user" as const, content: userMessage }] },
        {
          configurable: {
            thread_id: runThreadId,
            user_id: String(userId),
          },
          recursionLimit,
        },
      ),
      timer,
    ])) as { messages: any[] };

    await flushLangfuse();

    const messages: any[] = Array.isArray(result?.messages) ? result.messages : [];
    return {
      reply: extractReply(messages),
      modelSlug: resolved.modelSlug,
      vendorSlug: resolved.vendorSlug,
      modelName: resolved.modelName,
    };
  } catch (err) {
    logger.error("invokeDeepAgentOneShot failed", {
      agentId: agent.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
