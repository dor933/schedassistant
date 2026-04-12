import { RunnableConfig } from "@langchain/core/runnables";
import { Op } from "sequelize";
import { Agent, AgentAvailableSkill, User } from "@scheduling-agent/database";
import type {
  AssembledContext,
  UserIdentity,
  SessionSummary,
} from "@scheduling-agent/types";

import { getUserIdentity } from "../../../sessionsManagment/userIdentityManager";
import { loadRecentConversationMessagesForContext } from "../../../sessionsManagment/conversationLogForContext";
import { formatCheckpointMessagesForSystemPrompt } from "../../../sessionsManagment/checkpointMessagesForContext";
import { retrieveEpisodicMemory } from "../../../rag/episodicRetrieval";
import { loadRecentSessionSummaries } from "../../../sessionsManagment/sessionSummaryLoader";
import { embedText } from "../../../rag/embeddings";
import { AgentState } from "../../../state";
import { logger } from "../../../logger";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Epic orchestrator uses fewer messages to keep context focused. */
const EPIC_CONVERSATION_MESSAGE_LIMIT = 15;
const EPIC_CHECKPOINT_MESSAGE_LIMIT = 15;

/** Seeded executive accounts — only name and role, no full profiles. */
const GRAHAMY_EXECUTIVE_USER_NAMES = ["dor", "dan", "maor"] as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function loadMinimalExecutivesSection(): Promise<string> {
  try {
    const users = await User.findAll({
      where: { userName: { [Op.in]: [...GRAHAMY_EXECUTIVE_USER_NAMES] } },
      attributes: ["id", "userName", "displayName"],
    });
    if (users.length === 0) return "";

    const lines = users.map((u) => {
      const label = u.displayName?.trim() || u.userName;
      return `- **${label}** (userId: ${u.id})`;
    });
    return ["## Company executives", ...lines, ""].join("\n");
  } catch {
    return "";
  }
}

// ─── Epic Context Builder ───────────────────────────────────────────────────

/**
 * Builds a focused context for the epic orchestrator agent.
 *
 * Compared to the general context builder, this:
 * - Uses a much shorter conversation/checkpoint window (15 vs 50)
 * - Replaces the generic "orchestrator role" + delegation gate with an epic-focused role
 * - Shows minimal executive info (name + ID only)
 * - Skips the detailed "interacting with other agents" section
 * - Still loads: agent notes, workspace, skills, episodic memory, session summaries
 */
export async function buildEpicContext(
  state: AgentState,
  _config: RunnableConfig,
): Promise<AssembledContext> {
  const { userId, userInput, threadId, groupId, singleChatId, agentId, messages } = state;

  // ── 0. Agent metadata ──
  let agentDefinition: string | null = null;
  let agentCoreInstructions: string | null = null;
  let agentCharacteristics: Record<string, unknown> | null = null;
  let agentNotes: string | null = null;
  let agentWorkspacePath: string | null = null;
  let agentHasLinkedSkills = false;
  let agentName: string | null = null;

  if (agentId) {
    try {
      const agent = await Agent.findByPk(agentId, {
        attributes: [
          "definition", "agentName", "coreInstructions",
          "characteristics", "agentNotes", "workspacePath",
        ],
      });
      agentDefinition = agent?.definition?.trim() || null;
      agentName = agent?.agentName?.trim() || null;
      agentCoreInstructions = agent?.coreInstructions?.trim() || null;
      const ch = agent?.characteristics;
      agentCharacteristics =
        ch != null && typeof ch === "object" && !Array.isArray(ch)
          ? (ch as Record<string, unknown>)
          : null;
      agentNotes = agent?.agentNotes?.trim() || null;
      agentWorkspacePath = agent?.workspacePath ?? null;

      const skillLinkCount = await AgentAvailableSkill.count({ where: { agentId, active: true } });
      agentHasLinkedSkills = skillLinkCount > 0;
    } catch {
      throw new Error(`Failed to load agent from database: ${agentId}`);
    }
  }

  // ── 1. User identity (minimal) ──
  let userIdentity: UserIdentity | null = null;
  try {
    const user = await User.findByPk(userId);
    if (user?.userIdentity) userIdentity = user.userIdentity;
  } catch { /* proceed without */ }

  // ── 2. Core memory ──
  const coreMemory = await getUserIdentity(userId, groupId);

  // ── 3. Checkpoint messages (small window) ──
  const checkpointLog = formatCheckpointMessagesForSystemPrompt(messages, {
    singleChatId: singleChatId ?? null,
    groupId: groupId ?? null,
    maxMessages: EPIC_CHECKPOINT_MESSAGE_LIMIT,
  });

  // ── 4. Conversation log (small window) ──
  const conversationLog = await loadRecentConversationMessagesForContext(
    singleChatId ?? null,
    groupId ?? null,
    { limit: EPIC_CONVERSATION_MESSAGE_LIMIT },
  );

  // ── 5. Episodic memory ──
  let episodicSnippets: string[] = [];
  if (userInput) {
    try {
      const queryEmbedding = await embedText(userInput);
      episodicSnippets = await retrieveEpisodicMemory(agentId, queryEmbedding);
    } catch (err) {
      logger.warn("Episodic memory skipped for epic agent", {
        threadId,
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 6. Session summaries ──
  const recentSessionSummaries = await loadRecentSessionSummaries(agentId, {
    excludeThreadId: threadId,
  });

  // ── 7. Executives (minimal) ──
  const executivesSection = await loadMinimalExecutivesSection();

  // ── 8. Assemble system prompt ──
  const systemPrompt = formatEpicSystemPrompt({
    agentName,
    agentDefinition,
    agentCoreInstructions,
    agentCharacteristics,
    agentNotes,
    agentWorkspacePath,
    agentHasLinkedSkills,
    executivesSection,
    coreMemory,
    checkpointLogBody: checkpointLog.body,
    conversationLogBody: conversationLog.body,
    episodicSnippets,
    recentSummaries: recentSessionSummaries,
  });

  return {
    agentCoreInstructions,
    coreMemory,
    episodicSnippets,
    recentSessionSummaries,
    recentCheckpointMessageCount: checkpointLog.messageCount,
    recentConversationMessageCount: conversationLog.messageCount,
    userIdentity,
    groupMemberIdentities: null,
    systemPrompt,
  };
}

/**
 * LangGraph node — drop-in replacement for `contextBuilderNode` when the
 * agent is an epic orchestrator.
 */
export async function epicContextBuilderNode(
  state: AgentState,
  config: RunnableConfig,
): Promise<Partial<AgentState>> {
  if (state.error) return {};

  try {
    const ctx = await buildEpicContext(state, config);

    logger.info("Epic context assembled", {
      threadId: state.threadId,
      episodicCount: ctx.episodicSnippets.length,
      summaryCount: ctx.recentSessionSummaries.length,
      checkpointLogCount: ctx.recentCheckpointMessageCount,
      conversationLogCount: ctx.recentConversationMessageCount,
      promptLen: ctx.systemPrompt.length,
    });

    return {
      systemPrompt: ctx.systemPrompt,
      contextAssembled: true,
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown epic context-builder error";
    logger.error("Epic context assembly failed", { threadId: state.threadId, error: message });
    return { error: message };
  }
}

// ─── Formatting ─────────────────────────────────────────────────────────────

function formatEpicSystemPrompt(opts: {
  agentName: string | null;
  agentDefinition: string | null;
  agentCoreInstructions: string | null;
  agentCharacteristics: Record<string, unknown> | null;
  agentNotes: string | null;
  agentWorkspacePath: string | null;
  agentHasLinkedSkills: boolean;
  executivesSection: string;
  coreMemory: string;
  checkpointLogBody: string;
  conversationLogBody: string;
  episodicSnippets: string[];
  recentSummaries: SessionSummary[];
}): string {
  const sections: string[] = [];

  // ── Identity ──
  const name = opts.agentName || "Epic Orchestrator";
  sections.push(`## Your name is ${name}\n`);

  const role = opts.agentDefinition || "Project Manager — Epic Task Orchestrator";
  sections.push(`You are a **${role}**.\n`);

  // ── Role description (epic-specific, replaces generic orchestrator + delegation gate) ──
  sections.push("## Your role: Epic Task Orchestrator");
  sections.push(
    "You are a specialized **Project Manager** agent responsible for planning and executing " +
    "multi-step coding tasks (epics) across one or more repositories.\n\n" +

    "### What you do\n" +
    "- **Plan:** Break user requests into epics with stages and tasks\n" +
    "- **Execute:** Run tasks one at a time via Claude CLI on locally cloned repositories\n" +
    "- **Review:** Inspect git diffs after each task to verify correctness\n" +
    "- **Retry:** Provide specific, diff-referenced feedback when fixes are needed\n" +
    "- **Report:** Keep the user informed of progress between tasks\n\n" +

    "### What you do NOT do\n" +
    "- You do NOT execute tasks yourself — Claude CLI does the coding\n" +
    "- You do NOT access remote GitHub APIs or MCP servers — all repos are local clones\n" +
    "- You do NOT run more than one task per turn — the auto-continuation system handles sequencing\n" +
    "- You do NOT delegate to other agents — you are the executor for epic workflows\n\n" +

    "### Projects & repositories\n" +
    "You have access to the user's projects and repositories via these tools:\n" +
    "- **`list_projects`** — list all projects (name, ID, tech stack). " +
    "**Use this immediately** whenever the user asks about projects, mentions a project by name, " +
    "or before creating any epic.\n" +
    "- **`list_repositories`** — list repositories within a project (URL, local path, architecture). " +
    "Use this to confirm which repos are relevant before planning an epic.\n\n" +
    "Do NOT guess or say a project doesn't exist without calling `list_projects` first.\n\n" +
    "**Note:** The project named **\"grahamy\"** is the main project of the Grahamy company and our flagship product.\n\n" +

    "### Workflow\n" +
    "1. Load your Epic Task Workflow skill (`list_agent_skills` → `get_agent_skill`)\n" +
    "2. Use `list_projects` (and `list_repositories`) to identify the target project and repos\n" +
    "3. Follow the skill procedure exactly: clarify scope → plan epic → execute tasks → review diffs → report\n" +
    "4. After each task, provide a progress update. The system auto-continues to the next task.\n" +
    "5. Between stages, wait for PR approval before proceeding.",
  );
  sections.push("");

  // ── Honesty rules (kept, shorter) ──
  sections.push("## Rules");
  sections.push(
    "- Only claim you did something if a tool actually returned a result confirming it.\n" +
    "- If a tool call fails, say so honestly. Do not invent successful outcomes.\n" +
    "- If you don't know something, say so. Do not fabricate data, IDs, or file paths.\n" +
    "- Always use the structured tool-calling mechanism. Never simulate tool calls in text.",
  );
  sections.push("");

  // ── Agent instructions ──
  if (opts.agentCoreInstructions) {
    sections.push("## Agent instructions");
    sections.push(opts.agentCoreInstructions);
    sections.push("");
  }

  // ── Characteristics ──
  if (opts.agentCharacteristics && Object.keys(opts.agentCharacteristics).length > 0) {
    const lines: string[] = ["## Your Characteristics", ""];
    for (const [key, value] of Object.entries(opts.agentCharacteristics)) {
      if (value === undefined || value === null) continue;
      const formatted = typeof value === "object" ? JSON.stringify(value) : String(value);
      lines.push(`- **${key}:** ${formatted}`);
    }
    if (lines.length > 2) {
      sections.push(lines.join("\n"));
      sections.push("");
    }
  }

  // ── Agent notes ──
  if (opts.agentNotes) {
    sections.push("## Agent notes");
    sections.push(
      "Your persistent notes — tasks, project details, lessons learned from past executions. " +
      "Use `read_agent_notes`, `append_agent_notes`, `edit_agent_notes` to manage.",
    );
    sections.push("");
    sections.push(opts.agentNotes);
    sections.push("");
  }

  // ── Workspace ──
  if (opts.agentWorkspacePath) {
    sections.push("## Workspace");
    sections.push(
      "You have a persistent workspace folder for `.md` and `.txt` files. " +
      "Use `workspace_list_files`, `workspace_read_file`, `workspace_write_file`, " +
      "`workspace_edit_file`, `workspace_delete_file`.",
    );
    sections.push("");
  }

  // ── Skills ──
  if (opts.agentHasLinkedSkills) {
    sections.push("## Linked skills");
    sections.push(
      "You have skills attached — load them before starting work.\n\n" +
      "- `list_agent_skills` — list skill names and descriptions\n" +
      "- `get_agent_skill` — load the full skill text by ID\n" +
      "- `add_agent_skill` / `edit_agent_skill` — create or update skills\n\n" +
      "**Always load the Epic Task Workflow skill before planning or executing an epic.**",
    );
    sections.push("");
  }

  // ── Executives (minimal) ──
  const execTrim = opts.executivesSection.trim();
  if (execTrim.length > 0) {
    sections.push(execTrim);
    sections.push("");
  }

  // ── User context (minimal) ──
  const coreMemTrim = opts.coreMemory.trim();
  if (coreMemTrim.length > 0) {
    sections.push("## User context");
    sections.push(opts.coreMemory);
    sections.push("");
  }

  // ── Checkpoint messages ──
  const checkpointTrim = opts.checkpointLogBody.trim();
  if (checkpointTrim.length > 0) {
    sections.push(checkpointTrim);
    sections.push("");
  }

  // ── Conversation log ──
  const logTrim = opts.conversationLogBody.trim();
  if (logTrim.length > 0) {
    sections.push("## Recent messages");
    sections.push(logTrim);
    sections.push("");
  }

  // ── Session summaries ──
  if (opts.recentSummaries.length > 0) {
    sections.push("## Recent conversation summaries");
    for (const s of opts.recentSummaries) {
      sections.push(`- [${s.createdAt}] ${s.text}`);
    }
    sections.push("");
  }

  // ── Episodic memory ──
  if (opts.episodicSnippets.length > 0) {
    sections.push("## Relevant past context (from vector store)");
    sections.push(
      "Auto-retrieved knowledge chunks from previous executions, scoped to relevant repositories and projects. " +
      "If you need more context on a specific repo, pattern, or past decision, use `recall_episodic_memory` with a targeted query.",
    );
    for (const snippet of opts.episodicSnippets) {
      sections.push(`- ${snippet}`);
    }
    sections.push("");
  } else {
    sections.push("## Long-term memory");
    sections.push(
      "No auto-retrieved memories matched this turn. If you need context from past executions " +
      "(e.g. repo patterns, architectural decisions, task outcomes), use `recall_episodic_memory` " +
      "with a descriptive query to search your long-term memory.",
    );
    sections.push("");
  }

  return sections.join("\n");
}
