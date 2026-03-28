import { RunnableConfig } from "@langchain/core/runnables";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import type { SchedulerAgentState } from "../../../state";
import { persistSummarizationResult } from "../../../memory/sessionSummaryChunksWriter";
import { embedText } from "../../../memory/embeddings";
import { getLangfuseCallbackHandler, observeWithContext } from "../../../langfuse";
import { logger } from "../../../logger";
import { Vendor } from "@scheduling-agent/database";

/**
 * Zod schema for the structured output returned by the LLM during
 * session summarization.  Used with `llm.withStructuredOutput(schema)`.
 */
const sessionSummarizationSchema = z.object({
  summary: z
    .string()
    .describe(
      "A free-form text summary capturing the overall gist of the conversation.",
    ),
  chunks: z
    .array(z.string())
    .describe(
      "An array of semantically self-contained text chunks (3-8 sentences each) " +
        "suitable for vector retrieval.  Each chunk must make sense on its own, " +
        "include contextual framing, and never split a claim from its qualifier.",
    ),
});

let cachedLlm: ChatOpenAI | null = null;

async function getSummarizationLlm(): Promise<ChatOpenAI> {
  if (cachedLlm) return cachedLlm;
  const vendor = await Vendor.findOne({ where: { slug: "openai" }, attributes: ["apiKey"] });
  cachedLlm = new ChatOpenAI({
    modelName: "gpt-4o",
    temperature: 0,
    apiKey: vendor?.apiKey ?? undefined,
  });
  return cachedLlm;
}

/**
 * LangGraph node: runs when a guard determines that TTL or checkpoint-size
 * thresholds are exceeded, or when the session ends.
 *
 * Produces **both** a session summary and semantically coherent chunks in a
 * single LLM call via `withStructuredOutput`, then:
 *   1. Writes the summary to the `summary` JSONB column on `threads`.
 *   2. Embeds and inserts each chunk into `episodic_memory` for the user.
 */
export async function sessionSummarizationNode(
  state: SchedulerAgentState,
  _config: RunnableConfig,
): Promise<Partial<SchedulerAgentState>> {
  if (state.error) return {};

  const { userId, threadId, agentId, messages } = state;

  if (!messages || messages.length === 0) {
    logger.debug("Summarization skipped — no messages", { threadId });
    return {};
  }

  try {
    logger.info("Starting session summarization", { threadId, userId, messageCount: messages.length });

    return await observeWithContext(
      "session_summarization",
      async (span) => {
        const conversationText = messages
          .map((m) => {
            const role =
              typeof m._getType === "function" ? m._getType() : "unknown";
            const content =
              typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content);
            return `[${role}]: ${content}`;
          })
          .join("\n");

        if (span) {
          span.update({
            metadata: { threadId, userId, messageCount: messages.length },
          });
        }

        const llm = await getSummarizationLlm();
        const structuredLlm = llm.withStructuredOutput(
          sessionSummarizationSchema,
          { name: "session_summarization" },
        );

        const handler = getLangfuseCallbackHandler(userId, {
          threadId,
          node: "session_summarization",
        });

        const invokeConfig: RunnableConfig = {
          callbacks: handler ? ([handler] as RunnableConfig["callbacks"]) : undefined,
        };

        const result = await structuredLlm.invoke(
          [
            {
              role: "system",
              content:
                "You are summarizing a scheduling-assistant conversation for long-term memory. " +
                "Produce a concise summary AND an array of semantically self-contained chunks.\n\n" +
                "Chunking rules:\n" +
                "1. Each chunk must make sense on its own — never split mid-thought or separate a claim from its qualifier.\n" +
                "2. Group related exchanges (e.g. a full Q&A about a preference) into one chunk.\n" +
                "3. Aim for 3-8 sentences per chunk; prefer more chunks over fewer if topics are unrelated.\n" +
                "4. Include brief contextual framing so each chunk is understandable out of order.",
            },
            {
              role: "human",
              content: `Summarize and chunk the following conversation:\n\n${conversationText}`,
            },
          ],
          invokeConfig,
        );

        logger.info("Summarization LLM done, persisting results", {
          threadId,
          summaryLen: result.summary.length,
          chunkCount: result.chunks.length,
        });

        await persistSummarizationResult(
          threadId,
          userId,
          agentId,
          result.summary,
          result.chunks,
          embedText,
        );

        logger.info("Session summarization complete — summary and chunks persisted", { threadId });

        return {};
      },
      { threadId, userId, messageCount: messages.length },
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Session summarization failed";
    logger.error("Session summarization failed", { threadId, userId, error: message });
    return { error: message };
  }
}
