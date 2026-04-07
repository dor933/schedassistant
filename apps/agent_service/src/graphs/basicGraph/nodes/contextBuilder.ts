import { RunnableConfig } from "@langchain/core/runnables";
import { Op } from "sequelize";
import { Agent, AgentSkill, GroupMember, User } from "@scheduling-agent/database";
import type {
  AssembledContext,
  GroupMemberContextProfile,
  UserIdentity,
  SessionSummary,
} from "@scheduling-agent/types";

import { getUserIdentity } from "../../../sessionsManagment/userIdentityManager";
import { loadRecentConversationMessagesForContext } from "../../../sessionsManagment/conversationLogForContext";
import { formatCheckpointMessagesForSystemPrompt } from "../../../sessionsManagment/checkpointMessagesForContext";
import { retrieveEpisodicMemory } from "../../../rag/episodicRetrieval";
import { loadRecentSessionSummaries } from "../../../sessionsManagment/sessionSummaryLoader";
import { embedText } from "../../../rag/embeddings";
import { formatUserIdentityForPrompt } from "../../../utils/formatUserIdentityForPrompt";
import { AgentState } from "../../../state";
import { logger } from "../../../logger";
import { AgentId } from "@scheduling-agent/types";

/** Seeded executive accounts (see `20240101000026-seed-executive-users.js`). */
const GRAHAMY_EXECUTIVE_USER_NAMES = ["dor", "dan", "maor"] as const;

/**
 * Loads Dor, Dan, and Maor from the DB and formats a fixed-order section for the system prompt.
 */
async function loadGrahamyExecutivesSection(): Promise<string> {
  try {
    const users = await User.findAll({
      where: { userName: { [Op.in]: [...GRAHAMY_EXECUTIVE_USER_NAMES] } },
      attributes: ["id", "userName", "displayName", "userIdentity"],
    });
    const byUserName = new Map(users.map((u) => [u.userName, u]));
    const blocks: string[] = [];

    for (const userName of GRAHAMY_EXECUTIVE_USER_NAMES) {
      const u = byUserName.get(userName);
      if (!u) continue;
      const label = u.displayName?.trim() || userName;
      blocks.push(`### ${label}`);
      blocks.push(`- **userName:** ${u.userName}`);
      blocks.push(`- **userId:** ${u.id}`);
      const profile = formatUserIdentityForPrompt(u.userIdentity);
      if (profile) {
        blocks.push(profile);
      }
      blocks.push("");
    }

    if (blocks.length === 0) return "";
    return ["## Grahamy executives", "", ...blocks].join("\n");
  } catch (err) {
    logger.warn("Grahamy executives section skipped", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

async function loadAgentNameSection(agentId: AgentId): Promise<string> {
  const agent = await Agent.findByPk(agentId, { attributes: ["agentName"] });
  if (agent?.agentName) {
    return `## Your name is ${agent.agentName}\n\n`;
  }
  return "No name yet";
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

  // ── 0. Agent definition + core instructions + characteristics + ongoing requests (DB) ──
  let agentDefinition: string | null = null;
  let agentCoreInstructions: string | null = null;
  let agentCharacteristics: Record<string, unknown> | null = null;
  let agentNotes: string | null = null;
  let agentWorkspacePath: string | null = null;
  let agentHasLinkedSkills = false;
  if (agentId) {
    try {
      const agent = await Agent.findByPk(agentId, {
        attributes: ["definition", "coreInstructions", "characteristics", "agentNotes", "workspacePath"],
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

      const skillLinkCount = await AgentSkill.count({ where: { agentId } });
      agentHasLinkedSkills = skillLinkCount > 0;
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

  // ── 3. Episodic snippets (pgvector, scoped by agentId) ────────────
  // Uses OpenAI embeddings only — not the chat model (Anthropic/Google/OpenAI chat keys are separate).
  let episodicSnippets: string[] = [];
  if (userInput) {
    try {
      const queryEmbedding = await embedText(userInput);
      episodicSnippets = await retrieveEpisodicMemory(agentId, queryEmbedding);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("Episodic memory skipped (OpenAI embedding failed or missing key)", {
        threadId,
        agentId,
        error: message,
      });
    }
  }

  // ── 4. Recent session summaries (last 48h, max 2, scoped by agentId) ──
  const recentSessionSummaries = await loadRecentSessionSummaries(
    agentId,
    { excludeThreadId: threadId },
  );

  const grahamyExecutivesSection = await loadGrahamyExecutivesSection();

  const agentNameSection = await loadAgentNameSection(agentId);

  // ── 5. Assemble system prompt ──────────────────────────────────────
  const systemPrompt = formatSystemPrompt(
    agentDefinition,
    agentCoreInstructions,
    agentCharacteristics,
    agentNotes,
    agentWorkspacePath,
    agentHasLinkedSkills,
    grahamyExecutivesSection,
    agentNameSection,
    coreMemory,
    checkpointLog.body,
    conversationLog.body,
    episodicSnippets,
    recentSessionSummaries,
    groupMemberIdentities,
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

    logger.info("Context assembled", {
      threadId: state.threadId,
      hasAgentDef: !!ctx.agentCoreInstructions,
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

function formatSystemPrompt(
  agentDefinition: string | null,
  agentCoreInstructions: string | null,
  agentCharacteristics: Record<string, unknown> | null,
  agentNotes: string | null,
  agentWorkspacePath: string | null,
  agentHasLinkedSkills: boolean,
  grahamyExecutivesSection: string,
  agentNameSection: string,
  coreMemory: string,
  checkpointLogBody: string,
  conversationLogBody: string,
  episodicSnippets: string[],
  recentSummaries: SessionSummary[],
  groupMembers: GroupMemberContextProfile[] | null,
): string {
  const sections: string[] = [];

  const roleLabel = agentDefinition || "AI assistant";
  sections.push(
    agentNameSection + "\n\n" +
    `You are a ${roleLabel}.\n`,
  );

  sections.push("## Your role: orchestrator");
  sections.push(
    "You are primarily an **orchestrator**. " +
    "Your core strengths are your **memory**, your ability to give **precise, high-quality instructions**, " +
    "and your capacity to **learn from past outcomes and failures**.\n\n" +
    "You are **not** built to execute long multi-step processes end-to-end in a single run: " +
    "each run allows only a **limited** number of tool/model steps, so trying to chain many steps yourself " +
    "(instead of delegating) is **very likely to fail**, time out, or stop mid-task. " +
    "Assume multi-step pipelines belong with an **executor agent**, not with you alone.\n\n" +
    "You **can and should** handle straightforward operations directly:\n" +
    "- Reading / writing files from the workspace\n" +
    "- Running simple bash commands\n" +
    "- Simple, single-step tool calls (e.g. fetching a stock quote, looking up a calendar event)\n" +
    "- Looking up information you already have in context\n" +
    "- Answering questions from your own knowledge and memory\n\n" +
    "**Delegate to an executor agent** when the task is complex or heavy:\n" +
    "- Multi-step research or deep analysis that requires chaining many tool calls\n" +
    "- Writing, reviewing, or refactoring code\n" +
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
  sections.push("");

  if (agentCoreInstructions) {
    sections.push("## Agent instructions");
    sections.push(agentCoreInstructions);
    sections.push("");
  }

  sections.push("## Interacting with other agents");
  sections.push(
    "There are **two types** of agents in this system — make sure you use the right tool for each:\n\n" +
    "### Peer agents (fellow orchestrators)\n" +
    "These are agents like you — each with their own role, memory, and conversation history. " +
    "You can **talk to them directly** and get an immediate response.\n" +
    "- Use `list_agents` to discover available peer agents and get their IDs.\n" +
    "- Use `consult_agent` with the agent's ID to send them a message and receive their answer.\n" +
    "- Example: asking the Data Engineer agent about a pipeline, or the Project Manager about priorities.\n\n" +
    "### Executor agents (specialists)\n" +
    "These are **background specialists** built for complex, long-running tasks. " +
    "They can chain many tool calls, access external MCP servers, and work autonomously until the job is done. " +
    "You delegate work to them and receive the result asynchronously.\n" +
    "- Use `list_system_agents` to discover available executor agents.\n" +
    "- Use `delegate_to_deep_agent` to send them a task.\n" +
    "- Example: delegating a multi-step research analysis, code generation, or large data aggregation.\n\n" +
    "**When a user asks you to talk to, ask, or consult another agent — use `list_agents` + `consult_agent` (peer agents), " +
    "NOT `list_system_agents`.**\n\n" +
    "**When a task requires sustained multi-step work** (deep research, code writing, complex analysis) — " +
    "delegate to an executor agent via `list_system_agents` + `delegate_to_deep_agent` rather than attempting it yourself.",
  );
  sections.push("");

  sections.push("## Honesty, accuracy & tool usage — MANDATORY rules");
  sections.push(
    "These rules override any urge to be helpful. Violating them is worse than giving a disappointing answer.\n\n" +

    "### Never fabricate actions or results\n" +
    "- Only claim you did something if you actually invoked the corresponding tool **and** received a real result.\n" +
    "- NEVER write text that looks like a tool call, tool result, function call, API response, or system message. " +
    "Your tools are invoked through a structured mechanism — not through your message text.\n" +
    "- If a tool call fails, errors out, or is unavailable — say so honestly. Do NOT invent a successful outcome.\n" +
    "- If you are unsure whether a tool call went through, tell the user you are unsure rather than assuming success.\n\n" +

    "### Never invent information you don't have\n" +
    "- Do not make up data, statistics, dates, IDs, names, or any factual claims you cannot verify from your context or tool results.\n" +
    "- If you don't know something, say \"I don't know\" or \"I don't have that information\".\n" +
    "- If the user asks you to do something you cannot do with your available tools, explain what you can and cannot do — do not pretend.\n\n" +

    "### Prefer honesty over user satisfaction\n" +
    "- It is better to say \"I wasn't able to do that\" than to fabricate a result the user wants to hear.\n" +
    "- It is better to say \"I'm not sure\" than to confidently state something you made up.\n" +
    "- Never say \"Done!\" or \"Updated!\" unless you received confirmation from an actual tool result.\n" +
    "- If a tool is repeatedly failing, tell the user clearly instead of retrying silently and pretending it worked.\n\n" +

    "### Tool invocation\n" +
    "- Always use the structured tool-calling mechanism. Never simulate, quote, or role-play tool interactions in your message text.\n" +
    "- After invoking a tool, base your response strictly on the actual result returned — do not embellish, reinterpret, or add information that wasn't in the result.\n" +
    "- If you need to call a tool but something prevents you (e.g. missing parameters, unknown ID), ask the user for the missing information.",
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

  if (agentWorkspacePath) {
    sections.push("## Workspace");
    sections.push(
      "You have a persistent workspace folder where you can store, read, and edit `.md` and `.txt` files. " +
      "These files persist across all conversations and are private to you.\n\n" +
      "Available tools:\n" +
      "- `workspace_list_files` — list all files in your workspace\n" +
      "- `workspace_read_file` — read a file's content\n" +
      "- `workspace_write_file` — create or overwrite a file\n" +
      "- `workspace_edit_file` — replace a specific text snippet in a file\n" +
      "- `workspace_delete_file` — delete a file\n\n" +
      "Use your workspace for persistent documents, plans, research, templates, or any information " +
      "you want to retain and build upon over time.",
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

  const execTrim = grahamyExecutivesSection.trim();
  if (execTrim.length > 0) {
    sections.push(execTrim);
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
    sections.push("## Recent messages (durable conversation log)");
    sections.push(logTrim);
    sections.push("");
  }

  // Recent session summaries
  if (recentSummaries.length > 0) {
    sections.push("## Recent conversation summaries (last 48 hours)");
    for (const s of recentSummaries) {
      sections.push(`- [${s.createdAt}] ${s.text}`);
    }
    sections.push("");
  }

  // Episodic snippets
  if (episodicSnippets.length > 0) {
    sections.push("## Relevant past context");
    for (const snippet of episodicSnippets) {
      sections.push(`- ${snippet}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}
