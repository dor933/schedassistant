import { RunnableConfig } from "@langchain/core/runnables";
import { Op } from "sequelize";
import { Agent, GroupMember, User } from "@scheduling-agent/database";
import type {
  AssembledContext,
  GroupMemberContextProfile,
  UserIdentity,
  SessionSummary,
} from "@scheduling-agent/types";

import { getCoreMemory } from "../../../memory/coreMemoryManager";
import { retrieveEpisodicMemory } from "../../../memory/episodicRetrieval";
import { loadRecentSessionSummaries } from "../../../memory/sessionSummaryLoader";
import { embedText } from "../../../memory/embeddings";
import { SchedulerAgentState } from "../../../state";
import { logger } from "../../../logger";

/**
 * Builds the complete LLM context for one conversation turn.
 *
 * This function is designed to be called from a LangGraph node (or as a
 * helper inside one), following the same structural pattern as the nodes
 * in `graphs-example/nodes/vulnerabilityNodes.ts`.
 *
 * It assembles core memory, episodic snippets (user-scoped), and recent session
 * summaries scoped to the active `group_id` or `single_chat_id`, then formats
 * into a system prompt that the model receives as durable instructions.
 */
export async function buildContext(
  state: SchedulerAgentState,
  _config: RunnableConfig,
): Promise<AssembledContext> {
  const { userId, userInput, threadId, groupId, singleChatId, agentId } = state;

  // ── 0. Agent definition + core instructions (DB) ───────────────────
  let agentDefinition: string | null = null;
  let agentCoreInstructions: string | null = null;
  if (agentId) {
    try {
      const agent = await Agent.findByPk(agentId, {
        attributes: ["definition", "coreInstructions"],
      });
      const def = agent?.definition?.trim();
      agentDefinition = def && def.length > 0 ? def : null;
      const text = agent?.coreInstructions?.trim();
      agentCoreInstructions = text && text.length > 0 ? text : null;
    } catch {
      // agents table / row missing — continue without DB instructions.
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

  // ── 2. Core memory (on-disk markdown) ──────────────────────────────
  const coreMemory = await getCoreMemory(userId);

  // ── 3. Episodic snippets (pgvector, scoped by agentId) ────────────
  let episodicSnippets: string[] = [];
  if (userInput) {
    const queryEmbedding = await embedText(userInput);
    episodicSnippets = await retrieveEpisodicMemory(agentId, queryEmbedding);
  }

  // ── 4. Recent session summaries (last 48h, max 2, scoped by agentId) ──
  const recentSessionSummaries = await loadRecentSessionSummaries(
    agentId,
    { excludeThreadId: threadId },
  );

  // ── 5. Assemble system prompt ──────────────────────────────────────
  const systemPrompt = formatSystemPrompt(
    agentDefinition,
    agentCoreInstructions,
    coreMemory,
    episodicSnippets,
    recentSessionSummaries,
    userIdentity,
    groupMemberIdentities,
  );

  return {
    agentCoreInstructions,
    coreMemory,
    episodicSnippets,
    recentSessionSummaries,
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
  state: SchedulerAgentState,
  config: RunnableConfig,
): Promise<Partial<SchedulerAgentState>> {
  if (state.error) return {};

  try {
    const ctx = await buildContext(state, config);

    logger.info("Context assembled", {
      threadId: state.threadId,
      hasAgentDef: !!ctx.agentCoreInstructions,
      episodicCount: ctx.episodicSnippets.length,
      summaryCount: ctx.recentSessionSummaries.length,
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

function formatSystemPrompt(
  agentDefinition: string | null,
  agentCoreInstructions: string | null,
  coreMemory: string,
  episodicSnippets: string[],
  recentSummaries: SessionSummary[],
  identity: UserIdentity | null,
  groupMembers: GroupMemberContextProfile[] | null,
): string {
  const sections: string[] = [];

  const roleLabel = agentDefinition || "AI assistant";
  sections.push(
    `You are a helpful ${roleLabel}. ` +
      "Use the following context about the user to inform your responses.\n",
  );

  if (agentCoreInstructions) {
    sections.push("## Agent instructions");
    sections.push(agentCoreInstructions);
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
      if (m.userIdentity && Object.keys(m.userIdentity).length > 0) {
        const pairs = Object.entries(m.userIdentity)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `- **${k}:** ${v}`);
        if (pairs.length > 0) {
          sections.push(...pairs);
        }
      }
      sections.push("");
    }
  } else if (identity) {
    sections.push("## User profile");
    const pairs = Object.entries(identity)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `- **${k}:** ${v}`);
    if (pairs.length > 0) {
      sections.push(pairs.join("\n"));
    }
    sections.push("");
  }

  // Core memory (durable rules)
  sections.push("## Core scheduling preferences");
  sections.push(coreMemory);
  sections.push("");

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
