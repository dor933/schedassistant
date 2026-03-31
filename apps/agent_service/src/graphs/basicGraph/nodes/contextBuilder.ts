import { RunnableConfig } from "@langchain/core/runnables";
import { Op } from "sequelize";
import { Agent, GroupMember, User } from "@scheduling-agent/database";
import type {
  AssembledContext,
  GroupMemberContextProfile,
  UserIdentity,
  SessionSummary,
} from "@scheduling-agent/types";

import { getCoreMemory } from "../../../sessionsManagment/coreMemoryManager";
import { loadRecentConversationMessagesForContext } from "../../../sessionsManagment/conversationLogForContext";
import { formatCheckpointMessagesForSystemPrompt } from "../../../sessionsManagment/checkpointMessagesForContext";
import { retrieveEpisodicMemory } from "../../../rag/episodicRetrieval";
import { loadRecentSessionSummaries } from "../../../sessionsManagment/sessionSummaryLoader";
import { embedText } from "../../../rag/embeddings";
import { AgentState } from "../../../state";
import { logger } from "../../../logger";

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
  if (agentId) {
    try {
      const agent = await Agent.findByPk(agentId, {
        attributes: ["definition", "coreInstructions", "characteristics"],
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

  // ── 2. Core context: formatted users.user_identity (single-chat; group uses members above) ──
  const coreMemory = await getCoreMemory(userId, groupId);

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

  // ── 5. Assemble system prompt ──────────────────────────────────────
  const systemPrompt = formatSystemPrompt(
    agentDefinition,
    agentCoreInstructions,
    agentCharacteristics,
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
    `You are a helpful ${roleLabel}. ` +
      "Use the following context about the user to inform your responses.\n",
  );

  if (agentCoreInstructions) {
    sections.push("## Agent instructions");
    sections.push(agentCoreInstructions);
    sections.push("");
  }

  const charSection = formatCharacteristicsSection(agentCharacteristics);
  if (charSection) {
    sections.push(charSection);
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
