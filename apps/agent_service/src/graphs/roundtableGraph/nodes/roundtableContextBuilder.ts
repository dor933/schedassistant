import type { RunnableConfig } from "@langchain/core/runnables";
import { Agent, AgentAvailableSkill } from "@scheduling-agent/database";
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
import {
  loadRecentRoundtableSummaries,
  formatRoundtableSummariesSection,
} from "../../../sessionsManagment/roundtableSummaryLoader";

/**
 * LangGraph node: assembles the system prompt for a roundtable agent turn.
 *
 * Much lighter than the basic-graph context builder — it loads the current
 * agent's core instructions plus roundtable-specific briefing and recent
 * roundtable summaries, but omits group/single-chat context, user-identity
 * memory, episodic retrieval, conversation logs, and session summaries.
 */
export async function roundtableContextBuilderNode(
  state: AgentState,
  _config: RunnableConfig,
): Promise<Partial<AgentState>> {
  if (state.error) return {};

  try {
    const { agentId, roundtableConfig } = state;
    const sections: string[] = [];

    // ── Agent identity + core instructions ──────────────────────────────
    let agentDefinition: string | null = null;
    let agentCoreInstructions: string | null = null;
    let agentName: string | null = null;
    let agentNotes: string | null = null;
    let agentWorkspacePath: string | null = null;
    let agentHasLinkedSkills = false;
    let agentOrganizationId: string | null = null;

    if (agentId) {
      const agent = await Agent.findByPk(agentId, {
        attributes: [
          "definition",
          "agentName",
          "coreInstructions",
          "agentNotes",
          "workspacePath",
          "organizationId",
        ],
      });
      agentDefinition = agent?.definition?.trim() || null;
      agentName = agent?.agentName?.trim() || null;
      agentCoreInstructions = agent?.coreInstructions?.trim() || null;
      agentNotes = agent?.agentNotes?.trim() || null;
      agentWorkspacePath = agent?.workspacePath ?? null;
      agentOrganizationId = agent?.organizationId ?? null;

      const skillLinkCount = await AgentAvailableSkill.count({
        where: { agentId, active: true },
      });
      agentHasLinkedSkills = skillLinkCount > 0;
    }

    const displayName = agentName || agentDefinition || "Agent";

    // ── Identity ────────────────────────────────────────────────────────
    sections.push(`# You are ${displayName}\n`);

    // ── Organization summary + workspace agent (shared grounding) ──
    const [
      orgSummarySection,
      googleWorkspaceAgentSection,
      librarySection,
      recentRoundtableSummaries,
    ] = await Promise.all([
      loadOrganizationSummarySection(agentOrganizationId),
      loadGoogleWorkspaceAgentSection(agentOrganizationId),
      loadLibrarySection(agentId),
      loadRecentRoundtableSummaries(agentId, { limit: 2 }),
    ]);
    if (orgSummarySection.trim().length > 0) {
      sections.push(orgSummarySection);
    }
    if (librarySection.trim().length > 0) {
      sections.push(librarySection);
    }
    if (googleWorkspaceAgentSection.trim().length > 0) {
      sections.push(googleWorkspaceAgentSection);
    }

    if (agentCoreInstructions) {
      sections.push("## Your core instructions");
      sections.push(agentCoreInstructions);
      sections.push("");
    }

    // ── Roundtable briefing ─────────────────────────────────────────────
    if (roundtableConfig) {
      const {
        topic,
        roundNumber,
        maxTurnsPerAgent,
        agentOrder,
        includeUser,
        participantUser,
      } = roundtableConfig;
      const totalAgents = agentOrder.length;
      const turnsRemaining = maxTurnsPerAgent - (roundNumber + 1);
      const userDisplayName = participantUser?.displayName?.trim() || "The user";

      sections.push("## Roundtable discussion");
      sections.push(
        `You are participating in a **multi-agent roundtable discussion** on the following topic:\n\n` +
        `> ${topic}\n`,
      );

      sections.push("### Participants");
      for (const a of agentOrder) {
        const marker = a.agentId === agentId ? " **(you)**" : "";
        sections.push(`- ${a.definition}${marker}`);
      }
      if (includeUser && participantUser) {
        sections.push(
          `- ${userDisplayName} — human participant (contributes at the end of each round)`,
        );
      }
      sections.push("");

      sections.push("### Turn info");
      sections.push(
        `- Round: **${roundNumber + 1}** of **${maxTurnsPerAgent}**\n` +
        `- Agents in this round: **${totalAgents}**\n` +
        `- Turns remaining for you after this one: **${turnsRemaining}**\n`,
      );

      sections.push("### Your memory is your own — and so is everyone else's");
      sections.push(
        "**You are entering this roundtable with your own private memory and your own private data.** " +
        "Every other agent at the table is in the same situation: each has had separate conversations " +
        "with the user, accessed different tools, and stored different facts at different points in time. " +
        "Treat this as a first-class fact about the discussion:\n\n" +
        "- **Your knowledge may be stale.** Another agent may have spoken with the user more recently and " +
        "received corrections, updates, or new decisions that you have never seen. If something you " +
        "believe contradicts what another agent says, consider that they may simply have fresher data — " +
        "ask them when they learned it before defending your version.\n" +
        "- **Your knowledge may be uniquely fresh.** You may hold facts, user preferences, recent decisions, " +
        "or tool results that no one else at the table has access to. Do not assume the others know what " +
        "you know — **proactively share** anything that is relevant to the topic, even if it feels obvious " +
        "to you.\n" +
        "- **Always timestamp your knowledge.** When you contribute a fact, decision, or piece of context " +
        "from your own memory or tools, state **exactly when** it was captured (e.g. *\"as of yesterday's " +
        "1:1 with the user\"*, *\"from a calendar query I ran 2 minutes ago\"*, *\"the user told me this on " +
        "2026-04-15\"*). Without an explicit timestamp, the other agents have no way to compare your " +
        "information against their own potentially older or newer versions.\n" +
        "- **Reconcile, don't overwrite.** When two agents disagree, the goal is to figure out *whose data " +
        "is more recent and why* — not to assume the loudest agent is right.\n",
      );
      sections.push("");

      sections.push("### Discussion guidelines");
      sections.push(
        "- Read what other agents have said in the conversation history and **build on their contributions**.\n" +
        "- Stay focused on the topic. Contribute your unique expertise and perspective.\n" +
        "- Be concise but substantive — other agents need to read and react to your response.\n" +
        "- If you have access to tools that can provide concrete data or evidence for the discussion, **use them**.\n" +
        "- You may delegate tasks to executor agents if you need deep research — the call will block until the result is ready.\n" +
        "- Address other agents by name when referencing their points.\n" +
        "- On your final turn, summarize your key contributions and any open items.\n",
      );

      if (includeUser && participantUser) {
        sections.push(
          `A human participant (**${userDisplayName}**) is in this roundtable. ` +
          `Address them by name when relevant, react to their input just as you would another agent's, ` +
          `and remember they speak last in each round.\n`,
        );
      }
    }

    const recentRoundtableSection = formatRoundtableSummariesSection(
      recentRoundtableSummaries,
    );
    if (recentRoundtableSection) {
      sections.push(recentRoundtableSection);
      sections.push("");
    }

    // ── Agent notes ─────────────────────────────────────────────────────
    if (agentNotes) {
      sections.push("## Agent notes");
      sections.push(
        "Your own persistent notes — use `read_agent_notes` / `append_agent_notes` / `edit_agent_notes` to manage.",
      );
      sections.push(agentNotes);
      sections.push("");
    }

    // ── Workspace ───────────────────────────────────────────────────────
    if (agentWorkspacePath && (await hasFilesystemMcp(agentId))) {
      const sessionFolder = state.threadId
        ? `${agentWorkspacePath}/threads/${state.threadId}`
        : null;
      sections.push("## Workspace");
      sections.push(
        `Your persistent workspace lives at \`${agentWorkspacePath}\`. Access it via the ` +
        "**filesystem MCP** (server `filesystem`, rooted at `/app/data`): `list_directory`, " +
        "`read_text_file`, `write_file`, `edit_file`, `search_files`. Always use the absolute " +
        "path above as the prefix.\n\n" +
        "**Reading files — what each tool gives you.** Two tool families are available; pick " +
        "whichever fits the task.\n" +
        "- `read_text_file` (filesystem MCP) — any file under `/app/data`. Supports `head` " +
        "(first N lines) or `tail` (last N lines); cannot combine both or take middle slices.\n" +
        "- `search_files` (filesystem MCP) — filename glob. Not a content grep.\n" +
        "- `read_session_file` — files **inside a per-thread session folder**. Adds `offset` " +
        "+ `limit` for arbitrary line ranges, cross-thread access (past threads you " +
        "participated in), and a manifest-summary fallback when a file is missing.\n" +
        "- `grep_session_file` — content search with line numbers **inside a session-folder " +
        "file**. The filesystem MCP has no equivalent.\n\n" +
        "Rule of thumb: library / long references are usually read in full with " +
        "`read_text_file`; session files are usually *located* with `grep_session_file` + " +
        "`read_session_file` rather than pulled whole — but nothing forces this.\n\n" +
        "**Allowed file formats — writes are restricted to `.md` and `.txt` only.** Other " +
        "extensions are rejected before they hit disk.\n\n" +
        (sessionFolder
          ? (
              `**Per-thread session folder.** This roundtable thread has its own subfolder at ` +
              `**\`${sessionFolder}/\`**. Write any durable contributions (notes, drafts, position ` +
              `briefs) into that exact path — e.g. \`write_file("${sessionFolder}/my_notes.md", "...")\` — ` +
              `so they're captured into the session manifest and recoverable later via ` +
              `\`read_session_file\` and \`get_thread_summary\`. Writes outside this folder are saved ` +
              `but won't appear in the per-thread manifest.`
            )
          : ""),
      );
      sections.push("");
    }

    // ── Skills ──────────────────────────────────────────────────────────
    if (agentHasLinkedSkills) {
      sections.push("## Linked skills");
      sections.push(
        "This agent has skills attached. Use `list_agent_skills` + `get_agent_skill` to load them when relevant.",
      );
      sections.push("");
    }

    const systemPrompt = sections.join("\n");

    const sessionWorkspacePath = resolveSessionWorkspacePath(
      agentWorkspacePath,
      state.threadId,
    );
    if (sessionWorkspacePath) {
      try {
        await ensureSessionWorkspace(sessionWorkspacePath);
      } catch (err) {
        logger.warn("Failed to ensure roundtable session workspace folder", {
          threadId: state.threadId,
          sessionWorkspacePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info("Roundtable context assembled", {
      threadId: state.threadId,
      agentId,
      roundtableId: state.roundtableId,
      round: roundtableConfig?.roundNumber,
      promptLen: systemPrompt.length,
      sessionWorkspacePath,
    });

    return {
      systemPrompt,
      contextAssembled: true,
      sessionWorkspacePath,
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown roundtable context-builder error";
    logger.error("Roundtable context assembly failed", {
      threadId: state.threadId,
      error: message,
    });
    return { error: message };
  }
}
