import type { RunnableConfig } from "@langchain/core/runnables";
import { Agent, AgentAvailableSkill } from "@scheduling-agent/database";
import { AgentState } from "../../../state";
import { logger } from "../../../logger";

/**
 * LangGraph node: assembles the system prompt for a roundtable agent turn.
 *
 * Much lighter than the basic-graph context builder — it loads the current
 * agent's core instructions plus roundtable-specific briefing, but omits
 * group/single-chat context, user-identity memory, episodic retrieval,
 * conversation logs, and session summaries (all of which are irrelevant
 * inside a multi-agent roundtable discussion).
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

    if (agentId) {
      const agent = await Agent.findByPk(agentId, {
        attributes: [
          "definition",
          "agentName",
          "coreInstructions",
          "agentNotes",
          "workspacePath",
        ],
      });
      agentDefinition = agent?.definition?.trim() || null;
      agentName = agent?.agentName?.trim() || null;
      agentCoreInstructions = agent?.coreInstructions?.trim() || null;
      agentNotes = agent?.agentNotes?.trim() || null;
      agentWorkspacePath = agent?.workspacePath ?? null;

      const skillLinkCount = await AgentAvailableSkill.count({
        where: { agentId, active: true },
      });
      agentHasLinkedSkills = skillLinkCount > 0;
    }

    const displayName = agentName || agentDefinition || "Agent";

    // ── Identity ────────────────────────────────────────────────────────
    sections.push(`# You are ${displayName}\n`);

    if (agentCoreInstructions) {
      sections.push("## Your core instructions");
      sections.push(agentCoreInstructions);
      sections.push("");
    }

    // ── Roundtable briefing ─────────────────────────────────────────────
    if (roundtableConfig) {
      const { topic, roundNumber, maxTurnsPerAgent, agentOrder } = roundtableConfig;
      const totalAgents = agentOrder.length;
      const turnsRemaining = maxTurnsPerAgent - (roundNumber + 1);

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
      sections.push("");

      sections.push("### Turn info");
      sections.push(
        `- Round: **${roundNumber + 1}** of **${maxTurnsPerAgent}**\n` +
        `- Agents in this round: **${totalAgents}**\n` +
        `- Turns remaining for you after this one: **${turnsRemaining}**\n`,
      );

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
    if (agentWorkspacePath) {
      sections.push("## Workspace");
      sections.push(
        "You have a persistent workspace folder for `.md` and `.txt` files.\n" +
        "Tools: `workspace_list_files`, `workspace_read_file`, `workspace_write_file`, " +
        "`workspace_edit_file`, `workspace_delete_file`.",
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

    logger.info("Roundtable context assembled", {
      threadId: state.threadId,
      agentId,
      roundtableId: state.roundtableId,
      round: roundtableConfig?.roundNumber,
      promptLen: systemPrompt.length,
    });

    return {
      systemPrompt,
      contextAssembled: true,
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
