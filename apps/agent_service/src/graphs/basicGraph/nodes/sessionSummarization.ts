import { RunnableConfig } from "@langchain/core/runnables";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import type { AgentState } from "../../../state";
import { insertEpisodicMemoryChunks } from "../../../rag/episodicMemoryChunksWriter";
import { embedText } from "../../../rag/embeddings";
import { getLangfuseCallbackHandler, observeWithContext } from "../../../langfuse";
import { logger } from "../../../logger";
import { resolveEmbeddingProviderApiKey } from "../../../rag/embeddingProvider";
import { EmbeddingProvider } from "../../../types/providers";
import { Thread } from "@scheduling-agent/database";
import { SessionSummary } from "@scheduling-agent/types";

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
      "An array of high-value, semantically self-contained text chunks (3-8 sentences each) " +
        "suitable for long-term vector retrieval. " +
        "Only include chunks that contain genuinely important, reusable knowledge — " +
        "facts, decisions, preferences, domain insights, or actionable outcomes worth preserving. " +
        "Omit small talk, pleasantries, routine acknowledgements, and anything that would not " +
        "be useful when retrieved months later. Return an empty array if nothing qualifies.",
    ),
});

let cachedLlm: ChatOpenAI | null = null;

async function getSummarizationLlm(): Promise<ChatOpenAI> {
  if (cachedLlm) return cachedLlm;
  const apiKey = await resolveEmbeddingProviderApiKey(process.env.EMBEDDING_PROVIDER as EmbeddingProvider);
  cachedLlm = new ChatOpenAI({
    modelName: "gpt-4o",
    temperature: 0,
    apiKey,
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
  state: AgentState,
  _config: RunnableConfig,
): Promise<Partial<AgentState>> {
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
                "You are summarizing a conversation for long-term memory (domain-agnostic: the agent may specialize in any topic). " +
                "Produce a concise summary AND an array of high-value, semantically self-contained chunks.\n\n" +
                "IMPORTANT — chunk quality gate:\n" +
                "Only create chunks for information that is genuinely valuable to store long-term " +
                "and would be useful when retrieved weeks or months later. Good candidates:\n" +
                "  • Confirmed facts, decisions, or conclusions reached during the conversation.\n" +
                "  • User preferences, constraints, or profile details discovered or updated.\n" +
                "  • Domain insights, analysis outcomes, or actionable next steps.\n" +
                "  • Agreed-upon plans, commitments, or resolved blockers.\n\n" +
                "Do NOT create chunks for:\n" +
                "  • Small talk, greetings, pleasantries, or routine acknowledgements.\n" +
                "  • Repetitive back-and-forth that adds no new information.\n" +
                "  • Transient context that only makes sense within this session.\n" +
                "  • Content already fully captured by the summary alone.\n\n" +
                "If no part of the conversation qualifies, return an empty chunks array — that is perfectly fine.\n\n" +
                "Chunking rules (when chunks ARE warranted):\n" +
                "1. Each chunk must make sense on its own — never split mid-thought or separate a claim from its qualifier.\n" +
                "2. Group related exchanges (e.g. a full Q&A on one topic) into one chunk.\n" +
                "3. Aim for 3-8 sentences per chunk; prefer fewer, higher-quality chunks over many thin ones.\n" +
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

        const now = new Date();
        const summaryPayload: SessionSummary = {
          text: result.summary,
          createdAt: now.toISOString(),
          messageCount: undefined,
        };
         // Write summary JSONB to the threads row.
         Thread.update(
          {
            summary: summaryPayload,
            summarizedAt: now,
          },
          { where: { id: threadId } },
        );

        await insertEpisodicMemoryChunks(
          threadId,
          userId,
          agentId,
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
