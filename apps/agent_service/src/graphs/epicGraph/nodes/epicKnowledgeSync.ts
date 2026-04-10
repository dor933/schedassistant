import { RunnableConfig } from "@langchain/core/runnables";
import { isAIMessage, isToolMessage } from "@langchain/core/messages";
import { QueryTypes } from "sequelize";
import {
  sequelize,
  EpisodicMemory,
  EpicTask,
  Repository,
} from "@scheduling-agent/database";
import type { AgentId, ProjectId, RepositoryId } from "@scheduling-agent/types";

import { embedText } from "../../../rag/embeddings";
import { AgentState } from "../../../state";
import { logger } from "../../../logger";

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Similarity threshold for considering an existing chunk a "match" for update/delete.
 * Cosine distance < this means the chunks cover the same topic.
 */
const SIMILARITY_THRESHOLD = 0.15;

/**
 * Maximum chunks to store per repo per sync cycle.
 */
const MAX_CHUNKS_PER_SYNC = 10;

// ─── Types ──────────────────────────────────────────────────────────────────

interface RepoChange {
  repositoryId: RepositoryId;
  projectId: ProjectId;
  repoName: string;
  /** Key learnings from this round's execution for this repo. */
  knowledgeChunks: string[];
}

// ─── Node ───────────────────────────────────────────────────────────────────

/**
 * Post-callModel node that runs only for `epic_orchestrator` agents.
 *
 * After each turn, this node:
 * 1. Scans the conversation messages from this turn for tool results from
 *    `execute_epic_task` and `review_task_diff` — these contain execution
 *    reports, diffs, and architecture context.
 * 2. Extracts key learnings (what changed, what was built, what patterns were used).
 * 3. For each repo involved:
 *    - Searches existing episodic chunks (by repo_id + semantic similarity)
 *    - Deletes stale chunks that are now superseded
 *    - Upserts new chunks with repo_id and project_id
 */
export async function epicKnowledgeSyncNode(
  state: AgentState,
  _config: RunnableConfig,
): Promise<Partial<AgentState>> {
  // This node is only reachable for the epic orchestrator agent
  // (conditional edge in the graph gates on EPIC_ORCHESTRATOR_AGENT_ID).
  if (!state.agentId) return {};

  try {
    const repoChanges = await extractRepoChangesFromTurn(state);
    if (repoChanges.length === 0) {
      logger.debug("epicKnowledgeSync: no repo changes detected this turn", {
        threadId: state.threadId,
      });
      return {};
    }

    for (const change of repoChanges) {
      await syncRepoKnowledge(
        state.agentId,
        state.userId,
        state.threadId,
        change,
      );
    }

    logger.info("epicKnowledgeSync: completed", {
      threadId: state.threadId,
      repoCount: repoChanges.length,
      totalChunks: repoChanges.reduce((s, c) => s + c.knowledgeChunks.length, 0),
    });
  } catch (err) {
    // Knowledge sync failure is non-fatal — don't break the conversation
    logger.error("epicKnowledgeSync: failed", {
      threadId: state.threadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {};
}

// ─── Extract Changes ────────────────────────────────────────────────────────

/**
 * Scans the current turn's messages for tool results that contain
 * execution reports (diffs, file changes, architecture learnings).
 */
async function extractRepoChangesFromTurn(state: AgentState): Promise<RepoChange[]> {
  const messages = state.messages ?? [];

  // Collect tool result content from execute_epic_task and review_task_diff
  const executionReports: string[] = [];

  for (const msg of messages) {
    if (isToolMessage(msg)) {
      const content = typeof msg.content === "string" ? msg.content : "";
      // Look for execution reports (they have the structured format)
      if (
        content.includes("# Task Execution Report") ||
        content.includes("## Files Changed") ||
        content.includes("## Full Diff") ||
        content.includes("# Repository Review")
      ) {
        executionReports.push(content);
      }
    }
  }

  if (executionReports.length === 0) return [];

  // Find which epic/repos were involved by checking the epicContinuation state
  // or parsing the execution reports
  const epicCont = state.epicContinuation;
  if (!epicCont?.epicId) {
    // Try to find epicId from tool call args in AI messages
    const epicId = findEpicIdFromMessages(messages);
    if (!epicId) return [];
    return await buildRepoChanges(epicId, executionReports);
  }

  return await buildRepoChanges(epicCont.epicId, executionReports);
}

function findEpicIdFromMessages(messages: any[]): string | null {
  for (const msg of messages) {
    if (isAIMessage(msg) && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        if (tc.name === "execute_epic_task" && tc.args?.epicId) {
          return tc.args.epicId;
        }
      }
    }
  }
  return null;
}

async function buildRepoChanges(
  epicId: string,
  executionReports: string[],
): Promise<RepoChange[]> {
  const epic = await EpicTask.findByPk(epicId, {
    include: [{ model: Repository, as: "repositories" }],
  });
  if (!epic) return [];

  const repos = ((epic as any).repositories ?? []) as Repository[];
  if (repos.length === 0) return [];

  // Extract knowledge chunks from execution reports
  const chunks = extractKnowledgeChunks(executionReports);
  if (chunks.length === 0) return [];

  // For now, associate all chunks with all repos in the epic
  // (in the future, we could parse which files belong to which repo)
  return repos.map((repo) => ({
    repositoryId: repo.id as RepositoryId,
    projectId: epic.projectId as ProjectId,
    repoName: repo.name,
    knowledgeChunks: chunks.slice(0, MAX_CHUNKS_PER_SYNC),
  }));
}

/**
 * Extracts knowledge chunks from execution reports.
 * Focuses on: what files changed, what was built, architectural decisions.
 */
function extractKnowledgeChunks(reports: string[]): string[] {
  const chunks: string[] = [];

  for (const report of reports) {
    // Extract the diff stat section — tells us what files were modified
    const diffStatMatch = report.match(/## Files Changed\n```\n([\s\S]*?)```/);
    if (diffStatMatch?.[1]?.trim()) {
      chunks.push(`Files modified: ${diffStatMatch[1].trim()}`);
    }

    // Extract the task instructions + CLI summary for context on what was built
    const instructionsMatch = report.match(/## Instructions Given\n([\s\S]*?)(?=\n## )/);
    const cliSummaryMatch = report.match(/## CLI Output Summary\n([\s\S]*?)(?=\n## |$)/);

    if (instructionsMatch?.[1]?.trim() && cliSummaryMatch?.[1]?.trim()) {
      const combined =
        `Task: ${instructionsMatch[1].trim().slice(0, 500)}\n` +
        `Result: ${cliSummaryMatch[1].trim().slice(0, 500)}`;
      chunks.push(combined);
    } else if (cliSummaryMatch?.[1]?.trim()) {
      chunks.push(`Execution result: ${cliSummaryMatch[1].trim().slice(0, 800)}`);
    }
  }

  return chunks;
}

// ─── Sync to Vector Store ───────────────────────────────────────────────────

async function syncRepoKnowledge(
  agentId: AgentId,
  userId: number,
  threadId: string,
  change: RepoChange,
): Promise<void> {
  const now = new Date();

  for (const chunkText of change.knowledgeChunks) {
    const embedding = await embedText(chunkText);
    const vectorLiteral = `[${embedding.join(",")}]`;

    // Find existing similar chunks for this repo
    const existing = await sequelize.query<{ id: string; content: string; distance: number }>(
      `SELECT id, content, (embedding <=> :embedding::vector) AS distance
       FROM   episodic_memory
       WHERE  agent_id = :agentId
         AND  repository_id = :repositoryId
       ORDER  BY embedding <=> :embedding::vector
       LIMIT  3`,
      {
        replacements: {
          agentId,
          repositoryId: change.repositoryId,
          embedding: vectorLiteral,
        },
        type: QueryTypes.SELECT,
      },
    );

    // Delete stale chunks that are very similar (same topic, outdated info)
    const staleIds = existing
      .filter((r) => r.distance < SIMILARITY_THRESHOLD)
      .map((r) => r.id);

    if (staleIds.length > 0) {
      await EpisodicMemory.destroy({ where: { id: staleIds } });
      logger.debug("epicKnowledgeSync: removed stale chunks", {
        repoId: change.repositoryId,
        removedCount: staleIds.length,
      });
    }

    // Insert the new chunk
    await EpisodicMemory.create({
      userId,
      threadId,
      agentId,
      repositoryId: change.repositoryId,
      projectId: change.projectId,
      content: chunkText,
      embedding,
      metadata: {
        threadId,
        agentId,
        repositoryId: change.repositoryId,
        projectId: change.projectId,
        syncedAt: now.toISOString(),
        source: "epic_knowledge_sync",
      },
    });
  }

  logger.debug("epicKnowledgeSync: synced repo knowledge", {
    repoId: change.repositoryId,
    repoName: change.repoName,
    chunkCount: change.knowledgeChunks.length,
  });
}
