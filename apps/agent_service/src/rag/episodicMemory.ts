import { sequelize, EpisodicMemory } from "@scheduling-agent/database";
import { QueryTypes } from "sequelize";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import type { AgentId, UserId, EpisodicChunkMetadata } from "@scheduling-agent/types";

import { embedText, embedTexts } from "./embeddings";
import { resolveEmbeddingProviderApiKey } from "./embeddingProvider";
import { logger } from "../logger";

/**
 * Agent-scoped vector store helpers backing the `save_memory` / `search_memory`
 * tools. Memory follows the **agent**, so every chat with that agent has access
 * to the same body of remembered facts.
 */

/**
 * Embeds `content` and persists it as an episodic memory row for this agent.
 * Returns the inserted row's id on success, or null on failure (logged).
 */
export async function saveEpisodicMemory(params: {
  agentId: AgentId;
  userId?: UserId | null;
  content: string;
  metadata?: EpisodicChunkMetadata | null;
}): Promise<string | null> {
  const { agentId, userId = null, content, metadata = null } = params;
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const embedding = await embedText(trimmed);
    const row = await EpisodicMemory.create({
      agentId,
      userId,
      content: trimmed,
      embedding,
      metadata,
    });
    logger.info("Episodic memory saved", {
      id: row.id,
      agentId,
      userId,
      contentLen: trimmed.length,
    });
    return row.id;
  } catch (err) {
    logger.error("Failed to save episodic memory", {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── Chunked ingestion (for bulk sources like consultation transcripts) ─────

/**
 * Below this many characters (~400 tokens), skip LLM chunking entirely and
 * save the content as a single memory row. Chunking is overkill for short
 * blobs — one coherent idea should stay as one row.
 */
const CHUNKING_CHAR_THRESHOLD = Number(
  process.env.EPISODIC_CHUNKING_CHAR_THRESHOLD ?? 1600,
);

/** Model slug used by the chunker LLM. Intentionally cheap. */
const CHUNKER_MODEL = process.env.EPISODIC_CHUNKER_MODEL ?? "gpt-4o-mini";

/** Structured output schema the chunker returns. */
const chunkerSchema = z.object({
  summary: z
    .string()
    .describe(
      "A concise single-paragraph summary of the whole input. Used as the fallback memory when no chunks qualify.",
    ),
  chunks: z
    .array(z.string())
    .describe(
      "An array of high-value, self-contained chunks (3-8 sentences each) suitable for long-term vector retrieval. " +
        "Only include chunks that contain genuinely important, reusable knowledge — facts, decisions, preferences, " +
        "domain insights, or actionable outcomes worth preserving when retrieved months later. " +
        "Omit small talk, pleasantries, routine acknowledgements. Return an empty array if nothing qualifies.",
    ),
});

let _chunkerLlm: ChatOpenAI | null = null;

async function getChunkerLlm(): Promise<ChatOpenAI | null> {
  if (_chunkerLlm) return _chunkerLlm;
  const apiKey = await resolveEmbeddingProviderApiKey("openai");
  if (!apiKey) {
    logger.warn("Episodic chunker unavailable — no OpenAI API key configured");
    return null;
  }
  _chunkerLlm = new ChatOpenAI({
    modelName: CHUNKER_MODEL,
    temperature: 0,
    apiKey,
  });
  return _chunkerLlm;
}

/**
 * Ingests a (potentially long, multi-topic) blob of text into the agent's
 * episodic memory.
 *
 * Flow:
 * 1. Short content (below `CHUNKING_CHAR_THRESHOLD`) → single row via `saveEpisodicMemory`.
 * 2. Long content → cheap LLM splits it into `{ summary, chunks[] }`:
 *    - If `chunks` is empty, save the summary as a single row.
 *    - Otherwise batch-embed all chunks in one API call and bulk-insert them.
 * 3. Any failure (LLM down, embedding error, DB error) falls back to saving
 *    the raw blob as one row so nothing is ever lost silently.
 *
 * Use this for bulk ingestion (consultation transcripts, imported documents).
 * For individual model-decided saves, prefer `saveEpisodicMemory` — the model
 * already decided the content is a discrete memory.
 */
export async function saveEpisodicMemoryChunked(params: {
  agentId: AgentId;
  userId?: UserId | null;
  content: string;
  metadata?: EpisodicChunkMetadata | null;
}): Promise<{ saved: number; chunked: boolean }> {
  const { agentId, userId = null, content, metadata = null } = params;
  const trimmed = content.trim();
  if (!trimmed) return { saved: 0, chunked: false };

  // ── Gate 1: short content → single-row path ───────────────────────────
  if (trimmed.length < CHUNKING_CHAR_THRESHOLD) {
    const id = await saveEpisodicMemory({ agentId, userId, content: trimmed, metadata });
    return { saved: id ? 1 : 0, chunked: false };
  }

  // ── Gate 2: run the chunker LLM ───────────────────────────────────────
  const llm = await getChunkerLlm();
  if (!llm) {
    // Chunker not available — don't lose the content, save as one row.
    const id = await saveEpisodicMemory({ agentId, userId, content: trimmed, metadata });
    return { saved: id ? 1 : 0, chunked: false };
  }

  let summary: string;
  let chunks: string[];
  try {
    const structured = llm.withStructuredOutput(chunkerSchema, {
      name: "episodic_chunker",
    });
    const result = await structured.invoke([
      {
        role: "system",
        content:
          "You are splitting a long blob of text into long-term memory chunks. " +
          "Produce a concise summary AND an array of high-value, self-contained chunks.\n\n" +
          "IMPORTANT — chunk quality gate:\n" +
          "Only create chunks for information genuinely valuable long-term and useful when retrieved weeks or months later:\n" +
          "  • Confirmed facts, decisions, or conclusions.\n" +
          "  • Preferences, constraints, or profile details.\n" +
          "  • Domain insights, analysis outcomes, actionable next steps.\n\n" +
          "Do NOT create chunks for small talk, pleasantries, repetitive filler, or transient context.\n" +
          "If nothing qualifies, return an empty chunks array — the summary alone is enough.\n\n" +
          "Chunking rules (when chunks ARE warranted):\n" +
          "1. Each chunk must make sense on its own — never split mid-thought.\n" +
          "2. Group related exchanges (e.g. a full Q&A on one topic) into one chunk.\n" +
          "3. Aim for 3-8 sentences per chunk; prefer fewer, higher-quality chunks.\n" +
          "4. Include brief contextual framing so each chunk is understandable out of order.",
      },
      {
        role: "human",
        content: `Summarize and chunk the following:\n\n${trimmed}`,
      },
    ]);
    summary = result.summary;
    chunks = result.chunks;
  } catch (err) {
    logger.error("Episodic chunker LLM failed — falling back to single-row save", {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    const id = await saveEpisodicMemory({ agentId, userId, content: trimmed, metadata });
    return { saved: id ? 1 : 0, chunked: false };
  }

  // ── Empty chunks[] → save the summary as a single row ────────────────
  if (chunks.length === 0) {
    const id = await saveEpisodicMemory({
      agentId,
      userId,
      content: summary,
      metadata: { ...(metadata ?? {}), summarizedFromLongForm: true },
    });
    return { saved: id ? 1 : 0, chunked: false };
  }

  // ── Multiple chunks → batch embed + bulk insert ──────────────────────
  try {
    const embeddings = await embedTexts(chunks);
    const rows = chunks.map((c, i) => ({
      agentId,
      userId,
      content: c,
      embedding: embeddings[i],
      metadata: {
        ...(metadata ?? {}),
        chunkIndex: i,
        chunkCount: chunks.length,
      },
    }));
    const created = await EpisodicMemory.bulkCreate(rows);
    logger.info("Episodic memory chunked + saved", {
      agentId,
      chunkCount: created.length,
      summaryLen: summary.length,
    });
    return { saved: created.length, chunked: true };
  } catch (err) {
    logger.error("Episodic bulk chunk insert failed — falling back to single-row save", {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    const id = await saveEpisodicMemory({ agentId, userId, content: trimmed, metadata });
    return { saved: id ? 1 : 0, chunked: false };
  }
}

export interface EpisodicSearchResult {
  id: string;
  content: string;
  createdAt: Date;
  metadata: EpisodicChunkMetadata | null;
  /** Cosine distance (`embedding <=> query`). Lower = more similar. */
  distance: number;
}

/**
 * Semantic-search the agent's episodic memory for rows similar to `query`.
 *
 * **Isolation.** Results are restricted to:
 *   - rows owned by the caller's `userId` (private-to-that-user memories), AND
 *   - rows with `user_id IS NULL` (agent-wide memories — reserved for future
 *     use; today both `save_memory` and the consult auto-save always attach a
 *     userId, so nothing lands in this bucket by default).
 *
 * This prevents cross-user leakage: user B chatting with the same agent can
 * never retrieve memories user A saved privately.
 *
 * If `userId` is null/undefined the query only returns the agent-wide bucket —
 * an agent-internal call with no user context sees only truly general memories.
 */
export async function searchEpisodicMemory(params: {
  agentId: AgentId;
  userId: UserId | null;
  query: string;
  topK?: number;
}): Promise<EpisodicSearchResult[]> {
  const { agentId, userId, query } = params;
  const topK = Math.max(1, Math.min(params.topK ?? 5, 25));
  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    const embedding = await embedText(trimmed);
    const vectorLiteral = `[${embedding.join(",")}]`;

    const rows = await sequelize.query<{
      id: string;
      content: string;
      created_at: Date;
      metadata: EpisodicChunkMetadata | null;
      distance: number;
    }>(
      `SELECT id,
              content,
              created_at,
              metadata,
              embedding <=> :embedding::vector AS distance
         FROM episodic_memory
        WHERE agent_id = :agentId
          AND (user_id = :userId OR user_id IS NULL)
     ORDER BY embedding <=> :embedding::vector
        LIMIT :topK`,
      {
        replacements: { agentId, userId, embedding: vectorLiteral, topK },
        type: QueryTypes.SELECT,
      },
    );

    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      createdAt: r.created_at,
      metadata: r.metadata ?? null,
      distance: Number(r.distance),
    }));
  } catch (err) {
    logger.error("Episodic memory search failed", {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
