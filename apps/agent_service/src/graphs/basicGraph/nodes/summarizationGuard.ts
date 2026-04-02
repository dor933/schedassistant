import { Thread } from "@scheduling-agent/database";
import type { BaseMessage } from "@langchain/core/messages";
import type { AgentState } from "../../../state";
import { logger } from "../../../logger";

/**
 * Default thresholds — override via environment variables.
 *
 * TTL_IDLE_MINUTES:     max minutes since last activity before the session
 *                       is considered expired and must be summarized.
 * MAX_MESSAGES:         max message count in the conversation before
 *                       compaction via summarization is required.
 * MAX_CHECKPOINT_BYTES: max checkpoint payload size (if tracked) before
 *                       summarization fires.
 * MAX_CONTEXT_TOKENS:   max estimated token count across all messages before
 *                       summarization fires. Prevents hitting model context limits.
 */
const TTL_IDLE_MINUTES = parseInt(process.env.TTL_IDLE_MINUTES ?? "30", 10);
const MAX_MESSAGES = parseInt(process.env.MAX_MESSAGES ?? "50", 10);
const MAX_CHECKPOINT_BYTES = parseInt(
  process.env.MAX_CHECKPOINT_BYTES ?? "500000",
  10,
);
const MAX_CONTEXT_TOKENS = parseInt(
  process.env.MAX_CONTEXT_TOKENS ?? "80000",
  10,
);

/**
 * Estimates the token count for a list of messages.
 * Uses the ~4 chars per token heuristic which is accurate enough for
 * triggering summarization thresholds (not billing).
 */
function estimateTokens(messages: BaseMessage[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === "string") {
      totalChars += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") {
          totalChars += part.length;
        } else if (part && typeof part === "object" && "text" in part) {
          totalChars += String((part as any).text).length;
        }
      }
    }
  }
  return Math.ceil(totalChars / 4);
}

/**
 * Guard node that evaluates TTL, size, and token thresholds for the current session.
 *
 * Runs at the very start of every turn. Sets `needsSummarization = true`
 * when any threshold is exceeded so the routing function can branch to
 * the sessionSummarization node before context assembly.
 */
export async function summarizationGuardNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  // NOTE: always clear `error` so a stale failure from a previous checkpoint
  // does not short-circuit the entire turn. Fresh errors set by downstream
  // nodes (sessionSummarization, callModel) still propagate normally.

  const { threadId, messages } = state;

  try {
    // ── Size check: message count ────────────────────────────────────
    if (messages && messages.length >= MAX_MESSAGES) {
      logger.info("Thread size exceeded — summarization required", { threadId, messageCount: messages.length, threshold: MAX_MESSAGES });
      return { needsSummarization: true, error: null };
    }

    // ── Token check: estimated cumulative token count ────────────────
    if (messages && messages.length > 0) {
      const estimatedTokens = estimateTokens(messages);
      if (estimatedTokens >= MAX_CONTEXT_TOKENS) {
        logger.info("Thread token count exceeded — summarization required", {
          threadId,
          estimatedTokens,
          threshold: MAX_CONTEXT_TOKENS,
          messageCount: messages.length,
        });
        return { needsSummarization: true, error: null };
      }
    }

    // ── DB-backed checks (TTL + checkpoint size) ─────────────────────
    const session = await Thread.findOne({ where: { id: threadId } });

    if (!session) {
      // New session — nothing to summarize yet.
      return { needsSummarization: false, error: null };
    }

    // TTL: idle too long since last activity.
    if (session.lastActivityAt) {
      const idleMs = Date.now() - new Date(session.lastActivityAt).getTime();
      const idleMinutes = idleMs / 60_000;
      if (idleMinutes >= TTL_IDLE_MINUTES && !session.summarizedAt) {
        logger.info("Thread TTL expired (idle) — summarization required", { threadId, idleMinutes: Math.round(idleMinutes), threshold: TTL_IDLE_MINUTES });
        return { needsSummarization: true, error: null };
      }
    }

    // TTL: hard expiry.
    if (session.ttlExpiresAt && new Date(session.ttlExpiresAt) <= new Date()) {
      logger.info("Thread hard TTL expired — summarization required", { threadId });
      return { needsSummarization: true, error: null };
    }

    // Size: checkpoint byte estimate (if tracked by the application).
    if (
      session.checkpointSizeBytes &&
      Number(session.checkpointSizeBytes) >= MAX_CHECKPOINT_BYTES
    ) {
      logger.info("Thread checkpoint size exceeded — summarization required", { threadId, bytes: session.checkpointSizeBytes, threshold: MAX_CHECKPOINT_BYTES });
      return { needsSummarization: true, error: null };
    }

    return { needsSummarization: false, error: null };
  } catch (err) {
    logger.error("Summarization guard error", { threadId, error: String(err) });
    // On guard failure, skip summarization and proceed normally.
    return { needsSummarization: false, error: null };
  }
}
