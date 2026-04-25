import { RunnableConfig } from "@langchain/core/runnables";
import { Op } from "sequelize";
import { getLibraryPath, listLibraryFiles } from "../../../services/library.service";
import { hasFilesystemMcp } from "../../../tools/hasFilesystemMcp";
import {
  Agent,
  GroupMember,
  Organization,
  User,
} from "@scheduling-agent/database";
import type {
  AssembledContext,
  GroupMemberContextProfile,
  UserIdentity,
  SessionSummary,
} from "@scheduling-agent/types";

import { getUserIdentity } from "../../../sessionsManagment/userIdentityManager";
import { loadRecentConversationMessagesForContext } from "../../../sessionsManagment/conversationLogForContext";
import { formatCheckpointMessagesForSystemPrompt } from "../../../sessionsManagment/checkpointMessagesForContext";
import { loadRecentSessionSummaries } from "../../../sessionsManagment/sessionSummaryLoader";
import {
  loadRecentRoundtableSummaries,
  formatRoundtableSummariesSection,
  type RecentRoundtableSummary,
} from "../../../sessionsManagment/roundtableSummaryLoader";
import { formatUserIdentityForPrompt } from "../../../utils/formatUserIdentityForPrompt";
import { AgentState } from "../../../state";
import { logger } from "../../../logger";
import { AgentId } from "@scheduling-agent/types";
import {
  resolveSessionWorkspacePath,
  ensureSessionWorkspace,
} from "../../../workspace/sessionWorkspace";


async function loadAgentNameSection(agentId: AgentId): Promise<string> {
  const agent = await Agent.findByPk(agentId, { attributes: ["agentName"] });
  if (agent?.agentName) {
    return `## Your name is ${agent.agentName}\n\n`;
  }
  return "No name yet";
}

/**
 * Loads the admin-authored free-text `organizations.summary` and renders it
 * as a top-of-prompt section shared by every agent in the org. This gives
 * every agent common grounding about who it's working for (company / team /
 * product context) so individual agent definitions don't have to repeat it.
 *
 * Returns "" when no summary is set — the section is simply skipped.
 */
export async function loadOrganizationSummarySection(
  organizationId: string | null,
): Promise<string> {
  if (!organizationId) return "";
  try {
    const org = await Organization.findByPk(organizationId, {
      attributes: ["summary"],
    });
    const text = org?.summary?.trim();
    if (!text) return "";
    return [
      "## About this organization",
      "Shared context about the company / team you work for. " +
        "Every agent in this organization sees this — use it as common grounding " +
        "for any question about who \"we\" are.",
      "",
      text,
      "",
    ].join("\n");
  } catch (err) {
    logger.warn("Organization summary section skipped", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

/**
 * Looks up the organization's currently active web-search system agent and
 * renders a section telling this agent to route *all* web searches to it.
 * Exactly one web-search agent is active per org (enforced by the
 * `organizations.web_search_agent_id` pointer); this section names that
 * agent explicitly so the LLM never tries to do web search itself.
 */
async function loadWebSearchAgentSection(
  organizationId: string | null,
): Promise<string> {
  if (!organizationId) return "";
  try {
    const org = await Organization.findByPk(organizationId, {
      attributes: ["webSearchAgentId"],
    });
    const activeId = org?.webSearchAgentId ?? null;
    if (!activeId) return "";

    const agent = await Agent.findByPk(activeId, {
      attributes: ["id", "slug", "agentName", "description", "modelSlug"],
    });
    if (!agent) return "";

    const label = agent.agentName?.trim() || agent.slug || "Web Search Agent";
    const lines: string[] = [];
    lines.push("## Web search — dedicated system agent");
    lines.push(
      `This organization has **one** dedicated system agent for web search: ` +
        `**${label}** (slug: \`${agent.slug}\`). ` +
        "All web search, browsing, and up-to-date-information lookups MUST " +
        "be routed to this agent via `delegate_to_deep_agent`. " +
        "Do NOT attempt web searches yourself, and do NOT delegate them to any " +
        "other system agent — it is always this one.",
    );
    if (agent.description?.trim()) {
      lines.push("");
      lines.push(`> ${agent.description.trim()}`);
    }
    lines.push("");
    return lines.join("\n");
  } catch (err) {
    logger.warn("Web search agent section skipped", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

/**
 * Loads the "dedicated Google Workspace agent" section for the prompt. Every
 * org gets exactly one `google_workspace_agent` seeded at registration; it is
 * the single point through which Gmail / Calendar / Drive operations are
 * performed. Primary agents never carry the google_* tools themselves — they
 * must delegate to this agent via `delegate_to_deep_agent`.
 *
 * NOTE: "Google Workspace" here refers to Google's SaaS suite (Gmail, Google
 * Calendar, Google Drive). It is unrelated to each agent's *own workspace
 * folder* on disk (accessed via the filesystem MCP when attached).
 *
 * Permission inheritance: the Google Workspace agent performs the action, but
 * the `AgentUserScope` check is keyed to the *calling* primary's agent id, so
 * the primary's grants are what gate access — no new scope sharing needed.
 */
export async function loadGoogleWorkspaceAgentSection(
  organizationId: string | null,
): Promise<string> {
  if (!organizationId) return "";
  try {
    const agent = await Agent.findOne({
      where: {
        organizationId,
        slug: "google_workspace_agent",
        type: "system",
      },
      attributes: ["id", "slug", "agentName", "description"],
    });
    if (!agent) return "";

    const label = agent.agentName?.trim() || agent.slug || "Google Workspace Agent";
    const lines: string[] = [];
    lines.push("## Google Workspace (Gmail / Calendar / Drive) — dedicated system agent");
    lines.push(
      `This organization has **one** dedicated system agent for Google Workspace ` +
        `operations — i.e. Google's SaaS suite: Gmail, Google Calendar, Google Drive. ` +
        `That agent is **${label}** (slug: \`${agent.slug}\`). Every Gmail / Calendar / ` +
        "Drive action — reading events, creating events, listing or reading Drive files, " +
        "writing Drive files, listing inbox messages, sending email — MUST be routed to " +
        "this agent via `delegate_to_deep_agent`. Do NOT attempt Google Workspace calls " +
        "yourself (you don't have the tools), and do NOT delegate these tasks to any " +
        "other system agent — it is always this one.\n\n" +
        "**This is different from your own agent workspace folder.** Your workspace is a directory " +
        "on disk accessed via the filesystem MCP (separate section above) — that is the agent " +
        "workspace, not Google Workspace. Never confuse the two.\n\n" +
        "**Before delegating**, call `list_google_workspace_grants` to see which users you " +
        "are permitted to act on and which scopes you hold per user. Pick the correct email " +
        "from that list — never guess an email or use an internal user id.\n\n" +
        "When delegating, include in plain language:\n" +
        "1. **The subject user's email address** (from `list_google_workspace_grants`) — " +
        "this is what the Google Workspace agent will pass to the Google API via " +
        "domain-wide delegation.\n" +
        "2. **What operation** to perform (read events, create event, list inbox, send " +
        "email, etc.) and the relevant details (date range, recipient, file name, " +
        "message body, etc.).\n\n" +
        "The Google Workspace agent is the specialist — it translates the email + operation " +
        "into the actual Google API call. You just hand off intent.\n\n" +
        "Permissions are inherited from you — the Google Workspace agent authorizes each call " +
        "against YOUR grants (agent_user_scopes), not its own. If the user has not granted " +
        "you access to the requested scope, the delegation will return an authorization error.",
    );
    if (agent.description?.trim()) {
      lines.push("");
      lines.push(`> ${agent.description.trim()}`);
    }
    lines.push("");
    return lines.join("\n");
  } catch (err) {
    logger.warn("Google Workspace agent section skipped", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

/**
 * Renders a system-prompt section describing the shared organisation library —
 * a flat folder of admin-curated reference documents (policies, standards,
 * product briefs, domain cheat-sheets, etc.) that every agent in the org can
 * read via the filesystem MCP. Lists the current file inventory so agents know
 * what's available before walking the directory.
 *
 * Returns "" when the agent does not have the filesystem MCP server attached —
 * there is no way for such an agent to act on the guidance, so injecting it
 * would only add noise.
 */
export async function loadLibrarySection(agentId: AgentId | null): Promise<string> {
  if (!agentId) return "";
  if (!(await hasFilesystemMcp(agentId))) return "";

  let files: ReturnType<typeof listLibraryFiles> = [];
  try {
    files = listLibraryFiles();
  } catch (err) {
    logger.warn("Library section skipped", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }

  const libraryPath = getLibraryPath();
  const lines: string[] = [];
  lines.push("## Shared organisation library");
  lines.push(
    "Your organisation maintains a **shared library** of reference documents " +
      "uploaded by admins — policies, product briefs, standards, domain " +
      "cheat-sheets, anything every agent in the org should be able to " +
      "consult. It is read-only from your side; admins manage contents from " +
      "the admin UI.\n\n" +
      `**Path:** \`${libraryPath}\` (flat directory, original filenames)\n\n` +
      "Access it through the **filesystem MCP** (server name `filesystem`, " +
      "rooted at `/app/data`). Use `list_directory` on the path above to " +
      "browse, and `read_text_file` to read a specific document — pass " +
      "`head` (first N lines) or `tail` (last N lines) when a document is " +
      "long and you only need the beginning or end, so you do not pull the " +
      "whole file into context. Consult the library whenever a question " +
      "touches org-specific policies, terminology, or procedures. Never " +
      "`write_file`, `edit_file`, `move_file`, or delete anything under " +
      "this path — admins own it.",
  );
  if (files.length === 0) {
    lines.push("");
    lines.push("_No library files have been uploaded yet._");
  } else {
    lines.push("");
    lines.push("### Current library files");
    for (const f of files) {
      lines.push(`- \`${f.fileName}\` (${f.size} bytes)`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Builds the complete LLM context for one conversation turn.
 *
 * This function is designed to be called from a LangGraph node (or as a
 * helper inside one), following the same structural pattern as the nodes
 * in `graphs-example/nodes/vulnerabilityNodes.ts`.
 *
 * It assembles core memory, a snapshot of LangGraph checkpoint messages (thread
 * state), up to 50 recent rows from `conversation_messages` for this conversation
 * scope, episodic snippets, and recent session summaries, then formats into a system prompt.
 */
export async function buildContext(
  state: AgentState,
  _config: RunnableConfig,
): Promise<AssembledContext> {
  const { userId, userInput, threadId, groupId, singleChatId, agentId, messages } = state;

  // ── 0. Agent definition + core instructions + characteristics (DB) ──
  let agentDefinition: string | null = null;
  let agentCoreInstructions: string | null = null;
  let agentCharacteristics: Record<string, unknown> | null = null;
  let agentNotes: string | null = null;
  let agentWorkspacePath: string | null = null;
  let agentOrganizationId: string | null = null;
  let agentHasLinkedSkills = false;
  if (agentId) {
    try {
      const agent = await Agent.findByPk(agentId, {
        attributes: [
          "definition",
          "coreInstructions",
          "characteristics",
          "agentNotes",
          "workspacePath",
          "organizationId",
        ],
      });
      const def = agent?.definition?.trim();
      agentDefinition = def && def.length > 0 ? def : null;
      const text = agent?.coreInstructions?.trim();
      agentCoreInstructions = text && text.length > 0 ? text : null;
      const ch = agent?.characteristics;
      agentCharacteristics =
        ch != null && typeof ch === "object" && !Array.isArray(ch)
          ? (ch as Record<string, unknown>)
          : null;
      const notes = agent?.agentNotes?.trim();
      agentNotes = notes && notes.length > 0 ? notes : null;
      agentWorkspacePath = agent?.workspacePath ?? null;
      agentOrganizationId = agent?.organizationId ?? null;

      // Auto-assigned in-house skills (notes, workspace, skill library) are always
      // available via list_agent_skills/get_agent_skill — so the "Linked skills"
      // help section is always relevant, regardless of per-agent junction rows.
      agentHasLinkedSkills = true;
    } catch {
      throw new Error(`Failed to load agent from database: ${agentId}`);
    }
  }

  // ── 1. User identity: all group members (junction) vs single user ─────────
  let userIdentity: UserIdentity | null = null;
  let groupMemberIdentities: GroupMemberContextProfile[] | null = null;

  try {
    if (groupId) {
      const rows = await GroupMember.findAll({
        where: { groupId },
        attributes: ["userId"],
        order: [["userId", "ASC"]],
      });
      const memberIds = rows.map((r) => r.userId);
      if (memberIds.length > 0) {
        const users = await User.findAll({
          where: { id: { [Op.in]: memberIds } },
          attributes: ["id", "displayName", "userIdentity"],
        });
        const byId = new Map(users.map((u) => [u.id, u]));
        groupMemberIdentities = memberIds
          .map((id) => byId.get(id))
          .filter((u): u is NonNullable<typeof u> => u != null)
          .map((u) => ({
            userId: u.id,
            displayName: u.displayName ?? null,
            userIdentity: u.userIdentity ?? null,
          }));
      } else {
        groupMemberIdentities = [];
      }
    } else {
      const user = await User.findByPk(userId);
      if (user?.userIdentity) {
        userIdentity = user.userIdentity;
      }
    }
  } catch {
    // users / group_members may be empty — proceed without identity.
  }

  // ── 2. Core context: formatted users.user_identity (single-chat; group uses members above) ──
  const coreMemory = await getUserIdentity(userId, groupId);

  // ── 2b. LangGraph checkpoint snapshot (system prompt) — same messages follow as chat history in callModel ──
  const checkpointLog = formatCheckpointMessagesForSystemPrompt(messages, {
    singleChatId: singleChatId ?? null,
    groupId: groupId ?? null,
  });

  // ── 2c. Durable conversation log (DB; this single chat or group only; survives thread rotation) ──
  const conversationLog = await loadRecentConversationMessagesForContext(
    singleChatId ?? null,
    groupId ?? null,
  );

  // ── 3. Episodic snippets ─────────────────────────────────────────
  // Auto-injection of vector-store hits has been removed: embedding the
  // latest user message verbatim ("yes, do it" / "ok" / "thanks") produces
  // noise queries against pgvector that surface irrelevant snippets and
  // spend tokens for no signal. Past-context retrieval is now agent-driven —
  // the agent calls `recall_episodic_memory` with a real query when it
  // actually needs prior context. The "Long-term memory" prompt section
  // below describes the trigger conditions and the cascade.
  const episodicSnippets: string[] = [];

  // ── 4. Recent session summaries (last 48h, max 2, scoped by agentId) ──
  const recentSessionSummaries = await loadRecentSessionSummaries(
    agentId,
    { excludeThreadId: threadId },
  );

  const agentNameSection = await loadAgentNameSection(agentId);

  const [
    webSearchAgentSection,
    organizationSummarySection,
    googleWorkspaceAgentSection,
    librarySection,
    agentHasFilesystemMcp,
  ] = await Promise.all([
    loadWebSearchAgentSection(agentOrganizationId),
    loadOrganizationSummarySection(agentOrganizationId),
    loadGoogleWorkspaceAgentSection(agentOrganizationId),
    loadLibrarySection(agentId),
    hasFilesystemMcp(agentId),
  ]);

  // ── 4b. Recent roundtable summaries this agent participated in ──
  const roundtableSummaries = await loadRecentRoundtableSummaries(agentId, { limit: 2 });

  // ── 5. Assemble system prompt ──────────────────────────────────────
  const systemPrompt = formatSystemPrompt(
    agentDefinition,
    agentCoreInstructions,
    agentCharacteristics,
    agentNotes,
    agentWorkspacePath,
    agentHasFilesystemMcp,
    agentHasLinkedSkills,
    agentNameSection,
    webSearchAgentSection,
    googleWorkspaceAgentSection,
    organizationSummarySection,
    librarySection,
    coreMemory,
    checkpointLog.body,
    conversationLog.body,
    episodicSnippets,
    recentSessionSummaries,
    groupMemberIdentities,
    roundtableSummaries,
    threadId,
  );

  return {
    agentCoreInstructions,
    coreMemory,
    episodicSnippets,
    recentSessionSummaries,
    recentCheckpointMessageCount: checkpointLog.messageCount,
    recentConversationMessageCount: conversationLog.messageCount,
    userIdentity,
    groupMemberIdentities,
    systemPrompt,
    agentWorkspacePath,
  };
}

/**
 * LangGraph node that assembles context and writes the system prompt
 * into state.  Suitable for use with `graph.addNode("assembleContext", contextBuilderNode)`.
 */
export async function contextBuilderNode(
  state: AgentState,
  config: RunnableConfig,
): Promise<Partial<AgentState>> {
  if (state.error) return {};

  try {
    const ctx = await buildContext(state, config);

    // Resolve + create the per-thread session workspace folder if this agent
    // has a workspace at all. We do not gate on filesystem-MCP attachment here
    // — the directory is cheap to create and the FS-write instrumentation is
    // the one that decides whether to actually record writes into it.
    const sessionWorkspacePath = resolveSessionWorkspacePath(
      ctx.agentWorkspacePath,
      state.threadId,
    );
    if (sessionWorkspacePath) {
      try {
        await ensureSessionWorkspace(sessionWorkspacePath);
      } catch (err) {
        logger.warn("Failed to ensure session workspace folder", {
          threadId: state.threadId,
          sessionWorkspacePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info("Context assembled", {
      threadId: state.threadId,
      hasAgentDef: !!ctx.agentCoreInstructions,
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
      err instanceof Error ? err.message : "Unknown context-builder error";
    logger.error("Context assembly failed", { threadId: state.threadId, error: message });
    return { error: message };
  }
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function formatCharacteristicsSection(
  characteristics: Record<string, unknown> | null,
): string {
  if (!characteristics || Object.keys(characteristics).length === 0) {
    return "";
  }
  const lines: string[] = ["## Your Characteristics", ""];
  for (const [key, value] of Object.entries(characteristics)) {
    if (value === undefined || value === null) continue;
    const formatted =
      typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
    lines.push(`- **${key}:** ${formatted}`);
  }
  if (lines.length <= 2) return "";
  lines.push("");
  return lines.join("\n");
}

// ─── Role-specific system prompt sections ───────────────────────────────────

/**
 * Full orchestrator role block: delegation philosophy, 4-part specialization,
 * and the mandatory delegation hard gate. Only injected for agents whose
 * characteristics.role is "orchestrator" (or unset — backward compat default).
 */
function buildOrchestratorRoleSections(): string[] {
  const sections: string[] = [];

  sections.push("## Your role: orchestrator");
  sections.push(
    "You are primarily an **orchestrator**. " +
    "Your core strengths are your **memory**, your ability to give **precise, high-quality instructions**, " +
    "and your capacity to **learn from past outcomes and failures**.\n\n" +
    "You are **not** built to execute long multi-step processes end-to-end in a single run: " +
    "each run allows only a **limited** number of tool/model steps, so trying to chain many steps yourself " +
    "(instead of delegating) is **very likely to fail**, time out, or stop mid-task. " +
    "Assume multi-step pipelines belong with an **executor agent**, not with you alone.\n\n" +

    "### Organizational structure — you are a manager, not an individual contributor\n" +
    "Think of this org the way you'd think of a real company:\n" +
    "- **You and your peers** (other primary agents like the Project Manager, the DBA, the Stocks " +
    "Analyst, the Epic Orchestrator) are **managers**. You are colleagues. You can talk to each " +
    "other (`consult_agent`) but **you do not work for each other** and **you do not delegate work " +
    "to each other** — peers run their own teams.\n" +
    "- **Each manager (you included) has their own employees** — the system / executor agents that " +
    "appear in `list_system_agents`. They come in two flavors: **dedicated reports** (executors " +
    "explicitly owned by you — your private team) and **shared specialists** (org-wide executors " +
    "with no specific owner, like a company-wide IT or HR team — any manager can request their " +
    "help). `list_system_agents` already filters to exactly these two sets for you; another " +
    "manager's *dedicated* executors are intentionally **not visible** to you.\n" +
    "- **Real-world rule, enforced here too: \"one person should not have two managers, but one " +
    "manager can have many employees.\"** That means:\n" +
    "  - You do **not** route work through another peer to reach their employee. If you tried " +
    "to delegate to another primary's owned executor, the system would refuse — `delegate_to_deep_agent` " +
    "rejects cross-manager assignments at the DB level.\n" +
    "  - If you actually need a capability that lives on a peer's team, talk to **that peer** via " +
    "`consult_agent` (manager-to-manager). Don't try to reach around them to their reports.\n" +
    "  - You can freely fan work out to your own dedicated reports plus the org-shared specialists. " +
    "That's your team — use it.\n" +
    "- **Tool ↔ relationship mapping:**\n" +
    "  - `consult_agent` → manager-to-manager (peer primary). Synchronous Q&A; no work assignment.\n" +
    "  - `delegate_to_deep_agent` → manager-to-employee (your dedicated report or org-shared specialist). " +
    "Async work assignment; you write the brief, they execute.\n" +
    "  - `delegate_to_epic_orchestrator` → manager-to-specialized-manager (the Epic Orchestrator " +
    "agent owns code-change execution end-to-end via Claude CLI; treat it like a peer manager " +
    "you hand a whole project to, not an employee).\n\n" +

    "You **can and should** handle straightforward operations directly:\n" +
    "- Reading / writing files from the workspace\n" +
    "- Running simple bash commands\n" +
    "- Simple, single-step tool calls (e.g. fetching a stock quote, looking up a calendar event)\n" +
    "- Looking up information you already have in context\n" +
    "- Answering questions from your own knowledge and memory\n\n" +
    "**Delegate to the Epic Orchestrator** for actual code changes:\n" +
    "- Writing new features, fixing bugs, refactoring code, creating PRs\n" +
    "- Any task that results in **code being written or modified** in a repository\n" +
    "- Use `delegate_to_epic_orchestrator` — it plans epics, executes tasks via Claude CLI, reviews diffs, and manages PRs\n\n" +
    "**Delegate to an executor agent** (`delegate_to_deep_agent`) for complex non-code-change tasks:\n" +
    "- Multi-step research or deep analysis that requires chaining many tool calls\n" +
    "- Code inspection, review, or auditing (reading and analyzing code without changing it)\n" +
    "- Large data processing or aggregation across multiple sources\n" +
    "- Any task that benefits from a specialist's focused, long-running execution\n\n" +
    "Use your judgment: if you can answer quickly and accurately with a simple tool call or two, do it yourself. " +
    "If the task requires sustained, multi-step work — delegate it. " +
    "Your job is to **understand the user's intent**, **decide the best way to fulfill it**, " +
    "**craft clear instructions when delegating**, and **synthesize results** back to the user.",
  );
  sections.push("");

  sections.push("## Your core specialization: understand, instruct, deliver, learn");
  sections.push(
    "Your most important job is NOT to execute tasks — it is to be the **brain** of the operation. " +
    "You have four critical responsibilities that define your value:\n\n" +

    "### 1. Fully understand the user's request\n" +
    "- Never rush to delegate or act before you **truly understand** what the user wants.\n" +
    "- Ask clarifying questions if the request is ambiguous, incomplete, or could be interpreted multiple ways.\n" +
    "- Identify the real intent behind the request — what outcome does the user actually need?\n" +
    "- Understand the scope: what is included, what is excluded, what are the constraints?\n" +
    "- If the user gives a vague instruction like \"check that\" or \"do the thing\" — do NOT guess. " +
    "Ask what exactly they want checked, what success looks like, and what context matters.\n\n" +

    "### 2. Gather all necessary information before delegating\n" +
    "- Before sending a task to an executor agent, make sure you have **all the information** the executor will need.\n" +
    "- Pull from: the current conversation, your memory, agent notes, workspace files, user identity, and context.\n" +
    "- If critical information is missing, **ask the user** — do not let the executor agent guess or work with incomplete instructions.\n" +
    "- Think of yourself as a project manager writing a brief: the executor should be able to work autonomously " +
    "with what you provide, without needing to come back and ask questions.\n\n" +

    "### 3. Send the most accurate and detailed instructions to the executor\n" +
    "- Your delegation instructions are your **primary output**. Treat them with the same care as a final deliverable.\n" +
    "- Every delegation MUST include:\n" +
    "  - **Goal:** A clear, specific statement of what needs to be accomplished\n" +
    "  - **Full context:** All relevant background, user preferences, constraints, and prior findings\n" +
    "  - **Scope & resources:** Which endpoints, tools, data sources, or files to use\n" +
    "  - **Success criteria:** How the executor knows the task is complete and correct\n" +
    "  - **Output format:** How the result should be structured (bullet points, table, JSON, summary, etc.)\n" +
    "- Poor instructions lead to poor results. If an executor agent returns a bad result, " +
    "ask yourself first: \"Did I give clear enough instructions?\" before blaming the executor.\n\n" +

    "### 4. Deliver results and build your learning curve\n" +
    "When you receive results back from an executor agent:\n" +
    "- **Structure the results** clearly for the user — organize, summarize, highlight key findings, and present actionable insights.\n" +
    "- **Persist important outcomes** in your agent notes and memory so future conversations benefit from what was learned.\n" +
    "- **Learn from every delegation:** What worked? What instructions were unclear? What context was missing? " +
    "Update your notes with lessons learned so you continuously improve your delegation quality.\n" +
    "- **Build autonomic learning:** Over time, you should become better at anticipating what users need, " +
    "what information executors require, and what patterns lead to successful outcomes. " +
    "Your notes and memory are your learning curve — use them actively, not passively.\n" +
    "- If an executor result was incomplete or wrong, note **why** in your agent notes (e.g., \"executor needed X context that I didn't provide\") " +
    "so you don't repeat the same mistake.\n\n" +

    "**In short:** You are the brain. The executor is the hands. " +
    "A brilliant brain with sloppy instructions wastes everyone's time. " +
    "A brilliant brain that doesn't learn from outcomes never gets better. " +
    "Your value is measured by the quality of your understanding, instructions, delivery, and growth.",
  );
  sections.push("");

  sections.push("## MANDATORY Delegation Hard Gate (execute this algorithm BEFORE every response and BEFORE every tool call)");
  sections.push(
    "**This is a mechanical rule — when a condition is met, you MUST delegate. No discretion, no exceptions, even if the user explicitly says \"do it yourself\" or \"search that\".**\n\n" +

    "### Step 1 — Peer-agent exception (only allowed self-action)\n" +
    "If the task is **exclusively** an internal consultation with a peer agent " +
    "(i.e. you will only use `list_agents` and/or `consult_agent`) → you may proceed yourself.\n" +
    "Otherwise → go to Step 2.\n\n" +

    "### Step 2 — Intent Gate (detect research / discovery / verification by meaning)\n" +
    "If the user's request includes **any** of the following intents:\n" +
    "- Check / scan / verify / validate / map / compare / discover\n" +
    "- \"What is available / what works / what is blocked / what is missing\"\n" +
    "- Investigating errors, status codes (403, 401, 500…), entitlements, permissions\n" +
    "- Any phrasing whose meaning is: **find out or confirm information not already present in your context**\n\n" +
    "→ **MANDATORY delegation to executor.** Go to Step 4.\n\n" +

    "### Step 3 — Tool Gate (detect research by which tools would be needed)\n" +
    "If answering the request would require you to call **any** of these tools:\n" +
    "- `search_endpoints`\n" +
    "- `get_endpoint_docs`\n" +
    "- `call_api`\n" +
    "- `query_data`\n" +
    "- `fetch`\n" +
    "- Or any MCP tool that performs external lookups, API calls, or data retrieval\n\n" +
    "→ This counts as research → **MANDATORY delegation to executor.** Go to Step 4.\n\n" +

    "### Step 4 — Delegation procedure (when Steps 2 or 3 triggered)\n" +
    "1. **Do NOT execute any research/scan/lookup tool call yourself.** Not even \"just one quick call.\"\n" +
    "2. Use `list_system_agents` to find the appropriate executor agent.\n" +
    "3. Use `delegate_to_deep_agent` with a task description that includes:\n" +
    "   - **Goal:** what the user wants to achieve\n" +
    "   - **Endpoints / tools / scope:** which resources to use\n" +
    "   - **Success criteria:** how to know the task is done\n" +
    "   - **Output constraints:** format, length, or structure of the result\n" +
    "4. Respond to the user: explain that the task has been delegated to a specialist executor agent and they will be updated when the result is ready.\n\n" +

    "### Step 5 — Only if NONE of Steps 2–3 triggered\n" +
    "You may answer the user yourself, using **only** information already in your context, memory, agent notes, or workspace — " +
    "no external research, no API calls, no data fetching.\n\n" +

    "**Remember:** This gate is MECHANICAL. If a condition matches, delegate — period. " +
    "The user saying \"do it\", \"just check\", \"search for me\", or \"you do it\" does NOT override this rule. " +
    "You are an orchestrator, not an executor.",
  );

  return sections;
}

/**
 * Lightweight role block for non-orchestrator agents (specialists, researchers, etc.).
 * These agents work directly with their tools and don't have the mandatory delegation gate.
 * They can still delegate if they choose to, but it's not forced.
 */
function buildSpecialistRoleSections(role: string): string[] {
  const sections: string[] = [];

  sections.push(`## Your role: ${role}`);
  sections.push(
    `You are a **${role}** agent. Your job is to use your specialized knowledge, tools, and skills ` +
    "to directly accomplish tasks within your area of expertise.\n\n" +
    "**How you work:**\n" +
    "- Use your available tools directly to fulfill requests — you are a hands-on agent, not just a router.\n" +
    "- Apply your domain expertise to deliver accurate, high-quality results.\n" +
    "- When a task is outside your expertise or requires capabilities you don't have, " +
    "you may consult peer agents (`consult_agent`) or delegate to executor agents (`delegate_to_deep_agent`).\n" +
    "- Persist important findings in your agent notes and memory so you build expertise over time.\n\n" +
    "**Quality standards:**\n" +
    "- Be accurate — never fabricate information or results.\n" +
    "- Be thorough — complete the task fully, don't leave partial work.\n" +
    "- Be clear — structure your responses so the user can act on them.\n" +
    "- Learn from outcomes — if something didn't work, note why in your agent notes.",
  );

  return sections;
}

function formatSystemPrompt(
  agentDefinition: string | null,
  agentCoreInstructions: string | null,
  agentCharacteristics: Record<string, unknown> | null,
  agentNotes: string | null,
  agentWorkspacePath: string | null,
  agentHasFilesystemMcp: boolean,
  agentHasLinkedSkills: boolean,
  agentNameSection: string,
  webSearchAgentSection: string,
  googleWorkspaceAgentSection: string,
  organizationSummarySection: string,
  librarySection: string,
  coreMemory: string,
  checkpointLogBody: string,
  conversationLogBody: string,
  episodicSnippets: string[],
  recentSummaries: SessionSummary[],
  groupMembers: GroupMemberContextProfile[] | null,
  roundtableSummaries: RecentRoundtableSummary[] = [],
  threadId: string = "",
): string {
  const sections: string[] = [];

  const roleLabel = agentDefinition || "AI assistant";
  sections.push(
    agentNameSection + "\n\n" +
    `You are a ${roleLabel}.\n`,
  );

  const orgSummaryTrim = organizationSummarySection.trim();
  if (orgSummaryTrim.length > 0) {
    sections.push(orgSummaryTrim);
    sections.push("");
  }

  const libraryTrim = librarySection.trim();
  if (libraryTrim.length > 0) {
    sections.push(libraryTrim);
    sections.push("");
  }

  // Determine the agent's behavioral role from characteristics.
  // "orchestrator" (default) gets full delegation rules + hard gate.
  // Any other role gets lightweight instructions appropriate to their function.
  const agentRole =
    (agentCharacteristics?.role as string | undefined)?.toLowerCase() ?? "orchestrator";

  if (agentRole === "orchestrator") {
    sections.push(...buildOrchestratorRoleSections());
  } else {
    sections.push(...buildSpecialistRoleSections(agentRole));
  }
  sections.push("");

  if (agentCoreInstructions) {
    sections.push("## Agent instructions");
    sections.push(agentCoreInstructions);
    sections.push("");
  }

  sections.push("## Interacting with other agents");
  sections.push(
    "There are **three types** of agents in this system — make sure you use the right tool for each:\n\n" +
    "### Peer agents (fellow orchestrators)\n" +
    "These are agents like you — each with their own role, memory, and conversation history. " +
    "You can **talk to them directly** and get an immediate response.\n" +
    "- Use `list_agents` to discover available peer agents and get their IDs.\n" +
    "- Use `consult_agent` with the agent's ID to send them a message and receive their answer.\n" +
    "- Example: asking the Data Engineer agent about a pipeline, or the Project Manager about priorities.\n\n" +
    "### Epic Orchestrator (code changes)\n" +
    "A specialized **Project Manager** agent that plans and executes **actual code changes** across repositories. " +
    "It creates epic plans with stages and tasks, executes them via Claude CLI, reviews git diffs, and manages PRs.\n" +
    "- Use `delegate_to_epic_orchestrator` to send it a coding task.\n" +
    "- **Use this for any task that results in code being written, modified, or refactored** — " +
    "new features, bug fixes, refactors, migrations, config changes in repos, etc.\n" +
    "- Do NOT use executor agents (`delegate_to_deep_agent`) for code changes — always use the Epic Orchestrator.\n\n" +
    "### Executor agents (specialists)\n" +
    "These are **background specialists** built for complex, long-running **non-code-change** tasks. " +
    "They can chain many tool calls, access external MCP servers, and work autonomously until the job is done. " +
    "You delegate work to them and receive the result asynchronously.\n" +
    "- Use `list_system_agents` to discover available executor agents — this also shows which **MCP tools** each executor has access to.\n" +
    "- Use `delegate_to_deep_agent` to send them a task.\n" +
    "- **Use this for:** code inspection/review/auditing (reading code without changing it), " +
    "multi-step research, deep analysis, data aggregation, external API lookups.\n" +
    "- Do NOT use this for actual code changes — use the Epic Orchestrator instead.\n\n" +
    "**Executor agents have access to powerful MCP tools that you do NOT have.** " +
    "These include tools like `fetch` (HTTP requests), `github` (GitHub API), `bash` (shell commands), " +
    "`filesystem` (file I/O), `docker` (container management), and specialized data sources. " +
    "When you call `list_system_agents`, the response shows exactly which MCP tools each executor can use. " +
    "Use this information to pick the right executor and to reference specific tools in your delegation instructions " +
    "(e.g., \"use the `fetch` tool to call endpoint X\", \"use `github` to look up PR #123\").\n\n" +
    "**When a user asks you to talk to, ask, or consult another agent — use `list_agents` + `consult_agent` (peer agents), " +
    "NOT `list_system_agents`.**\n\n" +
    "**Summary:** Code changes → `delegate_to_epic_orchestrator`. " +
    "Code inspection / research / analysis → `delegate_to_deep_agent`. " +
    "Quick questions to peers → `consult_agent`.",
  );
  sections.push("");

  const webSearchTrim = webSearchAgentSection.trim();
  if (webSearchTrim.length > 0) {
    sections.push(webSearchTrim);
    sections.push("");
  }

  const googleWorkspaceTrim = googleWorkspaceAgentSection.trim();
  if (googleWorkspaceTrim.length > 0) {
    sections.push(googleWorkspaceTrim);
    sections.push("");
  }

  sections.push("## Projects & repositories");
  sections.push(
    "You have access to the user's registered projects and their repositories:\n" +
    "- **`list_projects`** — list all projects (name, ID, tech stack).\n" +
    "- **`list_repositories`** — list repositories within a project (URL, local path, architecture overview).\n\n" +
    "Use these tools when the user asks about projects, repos, codebases, or architecture. " +
    "Do NOT guess or say a project doesn't exist without calling `list_projects` first.\n\n" +
    "**Note:** The project named **\"grahamy\"** is the main project of the Grahamy company and our flagship product.",
  );
  sections.push("");

  sections.push("## Honesty");
  sections.push(
    "- Only claim you did something if a tool actually returned a confirming result.\n" +
    "- Never write text that mimics a tool call, tool result, function call, or API response — invoke tools through the structured mechanism.\n" +
    "- If a tool fails or is unavailable, say so. Do not invent a successful outcome or retry silently while pretending it worked.\n" +
    "- If you don't know something, say so. Do not fabricate data, IDs, dates, names, or paths.\n" +
    "- Base every claim about external state on the actual tool result — do not embellish or extrapolate beyond what was returned.",
  );
  sections.push("");

  const charSection = formatCharacteristicsSection(agentCharacteristics);
  if (charSection) {
    sections.push(charSection);
  }

  if (agentNotes) {
    sections.push("## Agent notes");
    sections.push(
      "These are your own persistent notes — important information you chose to remember. " +
      "This includes pending tasks, follow-ups, project details, user preferences, and anything else worth tracking. " +
      "Use `read_agent_notes` to get the latest version, `append_agent_notes` to add new entries, " +
      "and `edit_agent_notes` to correct, reorganize, or remove completed items.",
    );
    sections.push("");
    sections.push(agentNotes);
    sections.push("");
  }

  if (agentWorkspacePath && agentHasFilesystemMcp) {
    const sessionFolder = threadId
      ? `${agentWorkspacePath}/threads/${threadId}`
      : null;
    sections.push("## Workspace");
    sections.push(
      `Your persistent workspace lives at \`${agentWorkspacePath}\`. Files here survive across all ` +
      `conversations. Use the **filesystem MCP** (server name \`filesystem\`, rooted at \`/app/data\`) ` +
      `for every workspace action: \`list_directory\`, \`read_text_file\`, \`write_file\`, \`edit_file\`, ` +
      `\`search_files\`, \`create_directory\`, \`move_file\`. Always use the absolute path above as the ` +
      `prefix — never a relative path.\n\n` +
      "**Reading files — what each tool gives you.** You have two tool families for reading. " +
      "Pick whichever fits the task; nothing restricts you to one or the other.\n" +
      "- `read_text_file` (filesystem MCP) — reads any file under `/app/data` (library, " +
      "workspace root, session folder, anywhere). Supports `head` (first N lines) or `tail` " +
      "(last N lines) for long files; cannot combine both, cannot take middle slices.\n" +
      "- `search_files` (filesystem MCP) — finds files by **filename** glob across the " +
      "filesystem. Not a content grep.\n" +
      "- `read_session_file` — reads files **inside a per-thread session folder**. Adds " +
      "`offset` + `limit` for arbitrary line ranges (middle slices), cross-thread access to " +
      "any past thread you have episodic memory from, and a graceful fallback to the manifest " +
      "summary when a file has been moved or deleted.\n" +
      "- `grep_session_file` — content search with line numbers **inside a session-folder " +
      "file**. Returns matching lines (with context windows) so you can jump straight to the " +
      "right section. The filesystem MCP has no equivalent.\n\n" +
      "Rule of thumb: for canonical reference docs (library, long-form briefs) you often want " +
      "the whole file, so `read_text_file` is usually fine. For session files (user pastes, " +
      "captured research, working memory) you usually want to *locate* the relevant section " +
      "with `grep_session_file` + `read_session_file` rather than pull the whole body — but " +
      "nothing stops you from doing a full read when that's what you actually need.\n\n" +
      "**Allowed file formats — writes are restricted to `.md` and `.txt` only.** " +
      "Any other extension (.json, .csv, .pdf, .xlsx, …) is rejected by the system before it touches " +
      "disk. If you need to capture structured data, render it as Markdown (tables, fenced code blocks, " +
      "front-matter) inside a `.md` file — the system handles format conversion later when sending " +
      "files to users.\n\n" +
      "Use your workspace for persistent documents, plans, research, templates, or any information " +
      "you want to retain and build upon over time.\n\n" +
      (sessionFolder
        ? (
            `**Per-thread session folder — write durable artifacts here, NOT at the workspace root.**\n` +
            `This conversation's session folder is **\`${sessionFolder}/\`** (already created — you can ` +
            `\`list_directory\` it immediately). Every file you produce that contains content worth keeping ` +
            `(captured library docs, plans, briefs, analyses, research dumps, anything you might want to ` +
            `re-read later) **MUST be written under this exact absolute path**, e.g. ` +
            `\`write_file("${sessionFolder}/library_capture.md", "...")\`. Writes here are automatically ` +
            `captured into the session manifest, summarised when the thread closes, and indexed for vector ` +
            `retrieval — so a future you can recover them via \`recall_episodic_memory\` → ` +
            `\`get_thread_summary\` → \`read_session_file\`. Writes anywhere else under \`${agentWorkspacePath}\` ` +
            `are still saved on disk but **will NOT appear in the per-thread manifest** and therefore won't ` +
            `surface in future sessions. When the user asks you to "save X to your workspace", interpret ` +
            `that as "save X under the per-thread session folder above" unless they explicitly name a ` +
            `different path.\n\n`
          )
        : "") +
      "**Shared with executor/system agents you delegate to.** When you delegate a task via " +
      "`delegate_to_deep_agent` (or similar), the executor agent does not have its own workspace — it " +
      "writes into **this same directory** on your behalf, and its writes inside the per-thread folder " +
      "are captured the same way. After the delegation result comes back, check the `## Workspace writes` " +
      "section at the end of the executor's reply to see what it changed, then `read_text_file` (or " +
      "`read_session_file` for files inside the per-thread folder) to inspect them.",
    );
    sections.push("");
  }

  if (agentHasLinkedSkills) {
    sections.push("## Linked skills");
    sections.push(
      "This agent has **skills** attached — reusable instructions stored in the database. " +
        "Full text is not inlined here; load it with tools when relevant.\n\n" +
        "Available tools:\n" +
        "- `list_agent_skills` — list skill ids, names, slugs, and short descriptions (not the full body)\n" +
        "- `get_agent_skill` — load the full **skill_text** for a `skill_id` from that list\n" +
        "- `add_agent_skill` — create a new skill and attach it to this agent when the user wants a new playbook\n" +
        "- `edit_agent_skill` — update name, slug, description, and/or full **skill_text** for a linked skill\n\n" +
        "When a task matches a skill’s description or the user asks you to follow stored guidance, " +
        "call `list_agent_skills`, then `get_agent_skill` for the right id(s) before improvising.",
    );
    sections.push("");
  }

  // Identity: group (all members) or single user
  if (groupMembers && groupMembers.length > 0) {
    sections.push("## Group chat");
    sections.push(
      "You are in a group conversation with multiple users. " +
      "Each message includes a sender name so you can tell who is speaking. " +
      "Address users by name when relevant and keep track of who said what.",
    );
    sections.push("");
    sections.push("### Members");
    for (const m of groupMembers) {
      const label =
        m.displayName?.trim() ||
        `User ${m.userId}`;
      sections.push(`### ${label}`);
      sections.push(`- **userId:** ${m.userId}`);
      const profile = formatUserIdentityForPrompt(m.userIdentity);
      if (profile) {
        sections.push(...profile.split("\n"));
      }
      sections.push("");
    }
  }

  // Single-chat: `coreMemory` is formatted `users.user_identity` from getCoreMemory(). Group chats omit this block (members listed above).

  const coreMemTrim = coreMemory.trim();
  if (coreMemTrim.length > 0) {
    sections.push("## Core memory (long-term preferences & facts about the user)");
    sections.push(coreMemory);
    sections.push("");
  }

  const checkpointTrim = checkpointLogBody.trim();
  if (checkpointTrim.length > 0) {
    sections.push(checkpointTrim);
    sections.push("");
  }

  const logTrim = conversationLogBody.trim();
  if (logTrim.length > 0) {
    sections.push(logTrim);
    sections.push("");
  }

  // Recent session summaries
  if (recentSummaries.length > 0) {
    sections.push("## Recent conversation summaries (last 48 hours)");
    sections.push(
      "These are auto-generated summaries of prior sessions. They may contain inaccuracies — " +
      "verify key facts before acting on them.",
    );
    for (const s of recentSummaries) {
      const confidenceTag =
        s.confidence && s.confidence !== "high"
          ? ` [confidence: ${s.confidence}]`
          : "";
      sections.push(`- [${s.createdAt}]${confidenceTag} ${s.text}`);
    }
    sections.push("");
  }

  // Roundtable discussion summaries
  const rtSection = formatRoundtableSummariesSection(roundtableSummaries);
  if (rtSection) {
    sections.push(rtSection);
    sections.push("");
  }

  // ── Long-term memory (tool-driven, NOT auto-injected) ──
  // Snippets are deliberately not pre-fetched and dropped into the prompt:
  // the latest user message ("yes, do it" / "ok" / short replies) embeds
  // poorly and produces noise hits. You decide when memory matters and
  // call the tool with a real query.
  sections.push("## Long-term memory — call `recall_episodic_memory` when you need it");
  sections.push(
    "Past context (decisions, repo patterns, prior task outcomes, user preferences) is **not " +
    "auto-injected** into your prompt — you have to retrieve it yourself. Use these tools when " +
    "any of the trigger conditions below applies; do NOT fabricate past context from memory or " +
    "from the conversation log alone.\n\n" +

    "**Trigger — call `recall_episodic_memory` whenever:**\n" +
    "- The user references something from the past (\"the auth refactor we did\", \"last week's audit\", " +
    "\"that pattern we discussed\") — search for it instead of guessing.\n" +
    "- You're about to make a non-trivial decision (architecture, naming, tooling) and there might " +
    "be a prior decision worth aligning with.\n" +
    "- You're starting a substantial task and want to know if a similar one was done before.\n" +
    "- A user-preferences-y question comes up (\"how do I usually want X formatted?\") — past " +
    "interactions probably hold the answer.\n\n" +

    "**Crafting the query:** describe the topic in your own words, not the user's latest reply. " +
    "Good: \"prior decisions about session-folder file persistence\". Bad: passing \"yes\" or \"do it\" " +
    "verbatim — embeddings of bare affirmatives are noise.\n\n" +

    "**Cascade after a hit:** episodic snippets are short. If a snippet references a past thread " +
    "but you need more detail, call `get_thread_summary` with the thread_id from the snippet — " +
    "that returns the full saved summary plus a manifest of every session file written. If a " +
    "manifest entry looks promising, `read_session_file` (same thread_id + file path) fetches the " +
    "contents. Stop as soon as you have enough; you don't need to walk every step.\n\n" +

    "**When to skip:** simple reply-to-the-current-message turns, structural questions answerable " +
    "from the prompt itself, or workflow questions covered by your skills. Don't gratuitously fetch " +
    "memory on every turn — fetch when there's a real reason.",
  );
  sections.push("");

  return sections.join("\n");
}
