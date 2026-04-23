import { RunnableConfig } from "@langchain/core/runnables";
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
import {
  loadRecentRoundtableSummaries,
  formatRoundtableSummariesSection,
  type RecentRoundtableSummary,
} from "../../../sessionsManagment/roundtableSummaryLoader";
import { getEmbedderForAgent } from "../../../rag/embeddings";
import { AgentState } from "../../../state";
import { logger } from "../../../logger";
import {
  loadOrganizationSummarySection,
  loadGoogleWorkspaceAgentSection,
  loadLibrarySection,
} from "../../basicGraph/nodes/contextBuilder";
import { hasFilesystemMcp } from "../../../tools/hasFilesystemMcp";
import {
  resolveSessionWorkspacePath,
  ensureSessionWorkspace,
} from "../../../workspace/sessionWorkspace";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Epic orchestrator uses fewer messages to keep context focused. */
const EPIC_CONVERSATION_MESSAGE_LIMIT = 15;
const EPIC_CHECKPOINT_MESSAGE_LIMIT = 15;

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
  let agentOrganizationId: string | null = null;

  if (agentId) {
    try {
      const agent = await Agent.findByPk(agentId, {
        attributes: [
          "definition", "agentName", "coreInstructions",
          "characteristics", "agentNotes", "workspacePath",
          "organizationId",
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
      agentOrganizationId = agent?.organizationId ?? null;

      const skillLinkCount = await AgentAvailableSkill.count({ where: { agentId, active: true } });
      agentHasLinkedSkills = skillLinkCount > 0;
    } catch {
      throw new Error(`Failed to load agent from database: ${agentId}`);
    }
  }

  // ── 0b. Organization summary + Google Workspace agent blurbs ──
  const [organizationSummarySection, googleWorkspaceAgentSection, librarySection, agentHasFilesystemMcp] = await Promise.all([
    loadOrganizationSummarySection(agentOrganizationId),
    loadGoogleWorkspaceAgentSection(agentOrganizationId),
    loadLibrarySection(agentId),
    hasFilesystemMcp(agentId),
  ]);

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
      const embedder = await getEmbedderForAgent(agentId);
      const queryEmbedding = await embedder.embedText(userInput);
      const hits = await retrieveEpisodicMemory(agentId, queryEmbedding);
      episodicSnippets = hits.map(
        (h) => `(thread_id: ${h.threadId}) ${h.content}`,
      );
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

  // ── 6b. Recent roundtable summaries ──
  const roundtableSummaries = await loadRecentRoundtableSummaries(agentId, { limit: 1 });

  // ── 7. Assemble system prompt ──
  const systemPrompt = formatEpicSystemPrompt({
    agentName,
    agentDefinition,
    agentCoreInstructions,
    agentCharacteristics,
    agentNotes,
    agentWorkspacePath,
    agentHasFilesystemMcp,
    agentHasLinkedSkills,
    organizationSummarySection,
    googleWorkspaceAgentSection,
    librarySection,
    coreMemory,
    checkpointLogBody: checkpointLog.body,
    conversationLogBody: conversationLog.body,
    episodicSnippets,
    recentSummaries: recentSessionSummaries,
    roundtableSummaries,
    threadId,
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
    agentWorkspacePath,
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

    const sessionWorkspacePath = resolveSessionWorkspacePath(
      ctx.agentWorkspacePath,
      state.threadId,
    );
    if (sessionWorkspacePath) {
      try {
        await ensureSessionWorkspace(sessionWorkspacePath);
      } catch (err) {
        logger.warn("Failed to ensure epic session workspace folder", {
          threadId: state.threadId,
          sessionWorkspacePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info("Epic context assembled", {
      threadId: state.threadId,
      episodicCount: ctx.episodicSnippets.length,
      summaryCount: ctx.recentSessionSummaries.length,
      checkpointLogCount: ctx.recentCheckpointMessageCount,
      conversationLogCount: ctx.recentConversationMessageCount,
      promptLen: ctx.systemPrompt.length,
      sessionWorkspacePath,
    });

    return {
      systemPrompt: ctx.systemPrompt,
      contextAssembled: true,
      sessionWorkspacePath,
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
  agentHasFilesystemMcp: boolean;
  agentHasLinkedSkills: boolean;
  organizationSummarySection: string;
  googleWorkspaceAgentSection: string;
  librarySection: string;
  coreMemory: string;
  checkpointLogBody: string;
  conversationLogBody: string;
  episodicSnippets: string[];
  recentSummaries: SessionSummary[];
  roundtableSummaries: RecentRoundtableSummary[];
  threadId: string;
}): string {
  const sections: string[] = [];

  // ── Identity ──
  const name = opts.agentName || "Epic Orchestrator";
  sections.push(`## Your name is ${name}\n`);

  const role = opts.agentDefinition || "Project Manager — Epic Task Orchestrator";
  sections.push(`You are a **${role}**.\n`);

  // ── Organization summary (shared grounding for every agent in the org) ──
  const orgSummaryTrim = opts.organizationSummarySection.trim();
  if (orgSummaryTrim.length > 0) {
    sections.push(orgSummaryTrim);
    sections.push("");
  }

  // ── Shared organisation library (admin-uploaded reference docs) ──
  const libraryTrim = opts.librarySection.trim();
  if (libraryTrim.length > 0) {
    sections.push(libraryTrim);
    sections.push("");
  }

  // ── Google Workspace agent (Gmail / Calendar / Drive routed here) ──
  const googleWorkspaceTrim = opts.googleWorkspaceAgentSection.trim();
  if (googleWorkspaceTrim.length > 0) {
    sections.push(googleWorkspaceTrim);
    sections.push("");
  }

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
    "- You do NOT use `consult_agent` or other peers to **run your epic for you** — you own epic execution. " +
    "You **do** use **`delegate_to_deep_agent`** when the user needs **codebase exploration or inspection** " +
    "(see below) — same rule as primary orchestrators.\n\n" +

    "### Git diffs vs. browsing the repo (critical)\n" +
    "- **Do** inspect **git diffs** after each task and use the epic diff-review workflow — that is required and is **not** " +
    "the kind of \"inspection\" you delegate away.\n" +
    "- **Do not** read, list, search, or walk repository files **yourself** to learn **repo structure**, **find where a page " +
    "or route lives**, **map modules**, or otherwise **discover layout** — including via **MCP** (filesystem, bash on clone paths, etc.).\n" +
    "- **`list_projects` / `list_repositories`** are **metadata only** (IDs, paths, blurbs) — fine to use; they are not a substitute for in-repo discovery.\n\n" +

    "### Where codebase exploration belongs (like primary orchestrators)\n" +
    "- **Normal inspection** (locate a file, understand an area, find a page, read code without implementing): call **`list_system_agents`**, " +
    "then **`delegate_to_deep_agent`** to an appropriate executor (e.g. one with filesystem/MCP tools) — **do not** do this exploration yourself.\n" +
    "- **Large, comprehensive inspection** (wide audit, many subsystems, heavy survey of the codebase): **create an epic task** " +
    "so the task worker performs it in a structured step — not a giant one-off deep-agent brief.\n\n" +

    "### Orchestration limits (you are an orchestrator)\n" +
    "Same core constraint as primary orchestrators: you are **not** built for long, heavy, multi-step self-execution. " +
    "Each turn has a **limited** number of tool rounds — chaining many MCP calls, huge searches, recursive listings, " +
    "long installs, or exploratory file walks yourself will fail, time out, or waste the budget. **Keep your own tool use light:** " +
    "plan epics, run one coding task at a time, **review diffs**, report. Exploration and structural discovery go to **`delegate_to_deep_agent`** " +
    "or (when truly epic in scope) to a **dedicated epic task**.\n\n" +

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
    "4. After each task, provide a progress update. The system may auto-continue only while another task in the **same stage** is ready — not across a stage boundary.\n" +
    "5. Between stages, wait for PR approval before running tasks in the next stage.",
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
  if (opts.agentWorkspacePath && opts.agentHasFilesystemMcp) {
    const sessionFolder = opts.threadId
      ? `${opts.agentWorkspacePath}/threads/${opts.threadId}`
      : null;
    sections.push("## Workspace");
    sections.push(
      `Your persistent workspace lives at \`${opts.agentWorkspacePath}\`. Access it via the ` +
      "**filesystem MCP** (server `filesystem`, rooted at `/app/data`): `list_directory`, " +
      "`read_text_file`, `write_file`, `edit_file`, `search_files`. Always use the absolute " +
      "path above as the prefix.\n\n" +
      "**Allowed file formats — writes are restricted to `.md` and `.txt` only.** Other " +
      "extensions are rejected before they hit disk. Render structured data as Markdown " +
      "(tables, fenced code blocks) inside a `.md` file when you need it.\n\n" +
      (sessionFolder
        ? (
            `**Per-thread session folder — write durable artifacts here, NOT at the workspace root.**\n` +
            `This conversation's session folder is **\`${sessionFolder}/\`** (already created). ` +
            `Every durable artifact (epic plans, audit reports, large analyses) **MUST be written under ` +
            `this exact absolute path**, e.g. \`write_file("${sessionFolder}/epic_plan.md", "...")\`. ` +
            `Writes here are captured into the session manifest, summarised, and indexed for vector ` +
            `retrieval — so a future epic run can recover them via \`recall_episodic_memory\` → ` +
            `\`get_thread_summary\` → \`read_session_file\`. Writes anywhere else under ` +
            `\`${opts.agentWorkspacePath}\` are still saved but **will NOT appear in the per-thread ` +
            `manifest** and won't surface in future sessions.`
          )
        : ""),
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

  // ── Roundtable discussion summaries ──
  const rtSection = formatRoundtableSummariesSection(opts.roundtableSummaries);
  if (rtSection) {
    sections.push(rtSection);
    sections.push("");
  }

  // ── Episodic memory ──
  if (opts.episodicSnippets.length > 0) {
    sections.push("## Relevant past context (from vector store)");
    sections.push(
      "Auto-retrieved knowledge chunks from previous executions, scoped to relevant repositories and projects. " +
      "Each snippet is prefixed with its originating `thread_id` — if a snippet references a past " +
      "session or roundtable but lacks detail, call `get_thread_summary` with that thread_id to " +
      "pull the full saved summary, which also lists every file written into that session's " +
      "workspace. If a manifest entry looks like it holds the answer (e.g. a saved plan, audit, " +
      "or research brief), follow up with `read_session_file` (same thread_id + the file's path) " +
      "to fetch the contents. " +
      "If you need more context on a different repo, pattern, or decision, use `recall_episodic_memory` with a targeted query.",
    );
    for (const snippet of opts.episodicSnippets) {
      sections.push(`- ${snippet}`);
    }
    sections.push("");
  } else {
    sections.push("## Long-term memory");
    sections.push(
      "No auto-retrieved memories matched this turn. If you need context from past executions " +
      "(e.g. repo patterns, architectural decisions, task outcomes), follow this cascade: " +
      "first `recall_episodic_memory` with a descriptive query; if a hit references a past thread " +
      "but lacks detail, `get_thread_summary` for the full text plus its file manifest; if a " +
      "manifest file looks relevant, `read_session_file` to read it. Stop as soon as you have enough.",
    );
    sections.push("");
  }

  return sections.join("\n");
}
