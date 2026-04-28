import crypto from "node:crypto";
import { ApplicationAgentThread } from "@scheduling-agent/database";
import { logger } from "../logger";

/**
 * Returns the stable LangGraph thread id for a given (user, application_agent)
 * pair, creating the row on first call. Bumps `last_used_at` on every access
 * so we can later prune cold threads if needed.
 *
 * The thread id is what gets passed to the inner deep agent's
 * `configurable.thread_id` — same value across calls = same conversation
 * resumed from the PostgresSaver checkpoint.
 */
export async function resolveOrCreateApplicationAgentThread(input: {
  userId: number;
  applicationAgentId: string;
}): Promise<string> {
  const { userId, applicationAgentId } = input;

  const [row, created] = await ApplicationAgentThread.findOrCreate({
    where: { userId, applicationAgentId },
    defaults: {
      userId,
      applicationAgentId,
      threadId: crypto.randomUUID(),
    },
  });

  if (created) {
    logger.info("ApplicationAgentThread created", {
      userId,
      applicationAgentId,
      threadId: row.threadId,
    });
  } else {
    // Bump last_used_at without bothering with a transaction — best-effort.
    row.lastUsedAt = new Date();
    void row.save();
  }

  return row.threadId;
}
