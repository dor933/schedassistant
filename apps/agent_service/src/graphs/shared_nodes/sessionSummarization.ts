import { RunnableConfig } from "@langchain/core/runnables";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogle } from "@langchain/google";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod";

import type { AgentState } from "../../state";
import { insertEpisodicMemoryChunks } from "../../rag/episodicMemoryChunksWriter";
import { getEmbedderForAgent } from "../../rag/embeddings";
import { observeWithContext, getLangfuseCallbackHandler, flushLangfuse } from "../../langfuse";
import { logger } from "../../logger";
import { Thread } from "@scheduling-agent/database";
import { SessionSummary, SessionFileEntry } from "@scheduling-agent/types";
import { resolveModelSlug } from "../../chat/modelResolution";
import { anthropicBaseConfig } from "../../chat/anthropicContextManagement";
import { resolveOrgVendor } from "../../services/resolveOrgVendor";

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
  confidence: z
    .enum(["high", "medium", "low"])
    .describe(
      "How confident you are that this summary accurately captures the key facts and decisions. " +
        "'high' = all key facts were explicitly stated and unambiguous. " +
        "'medium' = some details required inference or the conversation was partially ambiguous. " +
        "'low' = significant portions were unclear, contradictory, or required guesswork.",
    ),
  chunks: z
    .array(z.string())
    .describe(
      "An array of high-value, semantically self-contained text chunks (3-8 sentences each) " +
        "suitable for long-term vector retrieval. " +
        "Only include chunks that contain genuinely important, reusable knowledge — " +
        "facts, decisions, preferences, domain insights, or actionable outcomes worth preserving. " +
        "Omit small talk, pleasantries, routine acknowledgements, and anything that would not " +
        "be useful when retrieved months later. Return an empty array if nothing qualifies. " +
        "Do NOT include content from the per-session files — those get their own summaries via `fileSummaries`.",
    ),
  fileSummaries: z
    .array(
      z.object({
        path: z
          .string()
          .describe(
            "The exact relative path of one of the files listed in the <files> block of the input. " +
              "Use the path verbatim — do not invent, normalise, or rename paths.",
          ),
        summary: z
          .string()
          .describe(
            "2-4 sentence content summary of what this file holds (topic, key facts, why it matters). " +
              "Written as natural prose so it works as both a human reference and a vector-search target.",
          ),
      }),
    )
    .describe(
      "One entry per file from the <files> block of the input. " +
        "Skip a file ONLY if you cannot infer anything about it from the conversation — never fabricate. " +
        "Return an empty array when the <files> block was empty.",
    ),
});

/**
 * Cheap, fast model per vendor used exclusively for session summarisation.
 * Summarisation is a structured-output task with bounded scope and runs once
 * per closed thread — paying for the agent's frontier chat model would be
 * wasteful. We still bill the agent's organisation (same vendor key) so cost
 * attribution stays correct, just on a much smaller model.
 */
const SUMMARIZATION_MODEL_BY_VENDOR: Record<string, string> = {
  openai: "gpt-4o",
  anthropic: "claude-haiku-4-5",
  google: "gemini-2.0-flash",
};

/**
 * Resolves a summarization LLM. Uses the agent's vendor (and the org's API
 * key for that vendor) so billing stays with the right tenant, but pins the
 * model to a cheap per-vendor default rather than the agent's own chat model.
 *
 * Deliberately NOT cached at module scope: API keys are per-org, and a cache
 * keyed only by vendor would leak one org's key into another org's call.
 * The cost of re-resolving is a couple of indexed lookups per summarization.
 */
async function getSummarizationLlm(agentId?: string | null): Promise<BaseChatModel> {
  // Resolve the agent's chat model only to discover its vendor + org key —
  // we will not actually pass this slug to the chat constructor.
  const agentChatSlug = await resolveModelSlug(agentId);
  const vendor = await resolveOrgVendor(agentChatSlug, agentId ?? null);
  if (!vendor) {
    throw new Error(
      `Cannot summarize session: unknown model "${agentChatSlug}" or agent has no organization`,
    );
  }
  if (!vendor.apiKey) {
    throw new Error(
      `Cannot summarize session: this organization has not configured an API key for ${vendor.vendorSlug}`,
    );
  }

  const summarizationSlug = SUMMARIZATION_MODEL_BY_VENDOR[vendor.vendorSlug];
  if (!summarizationSlug) {
    throw new Error(`Unsupported vendor "${vendor.vendorSlug}" for session summarization`);
  }

  switch (vendor.vendorSlug) {
    case "openai":
      return new ChatOpenAI({ modelName: summarizationSlug, temperature: 0, apiKey: vendor.apiKey });
    case "anthropic":
      return new ChatAnthropic({
        modelName: summarizationSlug,
        temperature: 0,
        apiKey: vendor.apiKey,
        ...(process.env.MERIDIAN_URL ? { anthropicApiUrl: process.env.MERIDIAN_URL } : {}),
        ...anthropicBaseConfig(),
      });
    case "google":
      return new ChatGoogle({ model: summarizationSlug, temperature: 0, apiKey: vendor.apiKey });
    default:
      throw new Error(`Unsupported vendor "${vendor.vendorSlug}" for session summarization`);
  }
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
  config: RunnableConfig,
): Promise<Partial<AgentState>> {
  if (state.error) return {};

  const { userId, threadId, agentId, messages, sessionFiles, sessionWorkspacePath } = state;

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

        // Files block injected verbatim so the LLM can pair each path with a
        // summary in `fileSummaries`. Empty list => block is omitted, the
        // schema contract still requires `fileSummaries: []` in that case.
        const filesBlock = formatSessionFilesBlock(sessionFiles);

        if (span) {
          span.update({
            metadata: { threadId, userId, messageCount: messages.length },
          });
        }

        const llm = await getSummarizationLlm(agentId);
        const structuredLlm = (llm as any).withStructuredOutput(
          sessionSummarizationSchema,
          { name: "session_summarization" },
        );

        const langfuseHandler = getLangfuseCallbackHandler(userId, {
          threadId,
          agentId,
          service: "session_summarization",
        });

        const result = await structuredLlm.invoke(
          [
            {
              role: "system",
              content:
                "You are summarizing a conversation for long-term memory (domain-agnostic: the agent may specialize in any topic). " +
                "Produce a concise summary, an array of high-value semantic chunks, AND one short summary per file " +
                "listed in the input's <files> block.\n\n" +
                "LANGUAGE RULE: Always write everything in English, regardless of what language the conversation was conducted in.\n\n" +
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
                "  • Content already fully captured by the summary alone.\n" +
                "  • Content that belongs to a file in <files> — that goes into `fileSummaries`, not `chunks`.\n\n" +
                "If no part of the conversation qualifies, return an empty chunks array — that is perfectly fine.\n\n" +
                "Chunking rules (when chunks ARE warranted):\n" +
                "1. Each chunk must make sense on its own — never split mid-thought or separate a claim from its qualifier.\n" +
                "2. Group related exchanges (e.g. a full Q&A on one topic) into one chunk.\n" +
                "3. Aim for 3-8 sentences per chunk; prefer fewer, higher-quality chunks over many thin ones.\n" +
                "4. Include brief contextual framing so each chunk is understandable out of order.\n\n" +
                "FILE SUMMARIES — when the input contains a <files> block:\n" +
                "Each file in that block was written into the per-session workspace during this conversation. " +
                "Emit ONE entry in `fileSummaries` per file, using the EXACT path from the block (verbatim — do not " +
                "rename, normalise, or invent paths). Each summary must be 2-4 sentences of natural prose describing " +
                "what the file contains, its topic, and why it matters — these become standalone vector-search " +
                "targets, so write them as if a future reader had no other context. If you genuinely cannot infer " +
                "anything about a file from the conversation, omit it (do NOT fabricate). When the <files> block " +
                "is empty, return an empty `fileSummaries` array.",
            },
            {
              role: "human",
              content:
                `Summarize and chunk the following conversation:\n\n${conversationText}` +
                (filesBlock ? `\n\n${filesBlock}` : ""),
            },
          ],
          langfuseHandler ? { callbacks: [langfuseHandler] } : undefined,
        );

        await flushLangfuse();

        // Merge LLM-emitted file summaries onto the captured manifest. Only
        // entries whose `path` matches a real recorded file are kept — the
        // schema asks the model to use exact paths, but we defend against
        // hallucinated entries here so the manifest stays trustworthy.
        const mergedFiles = mergeFileSummaries(sessionFiles, result.fileSummaries);

        logger.info("Summarization LLM done, persisting results", {
          threadId,
          summaryLen: result.summary.length,
          chunkCount: result.chunks.length,
          fileCount: mergedFiles.length,
          confidence: result.confidence,
        });

        const now = new Date();
        const summaryPayload: SessionSummary = {
          text: result.summary,
          createdAt: now.toISOString(),
          messageCount: messages.length,
          confidence: result.confidence,
          ...(sessionWorkspacePath ? { workspacePath: sessionWorkspacePath } : {}),
          ...(mergedFiles.length > 0 ? { files: mergedFiles } : {}),
        };
        await Thread.update(
          {
            summary: summaryPayload,
            summarizedAt: now,
          },
          { where: { id: threadId } },
        );

        const embedder = await getEmbedderForAgent(agentId);

        // Conversation chunks — tagged "conversation" so retrieval can later
        // distinguish them from file-summary chunks (still ranked together
        // by default; the kind metadata is informational, not a namespace).
        if (result.chunks.length > 0) {
          await insertEpisodicMemoryChunks(
            threadId,
            userId,
            agentId,
            result.chunks,
            embedder.embedText,
            {
              source: "session_summarization",
              extraMetadata: { kind: "conversation" },
            },
          );
        }

        // One chunk per summarised file. Each chunk = the file summary plus
        // a structured `[source: ...]` tail so semantic search hits the
        // file's topic and the agent recovers the path for free. Per-chunk
        // metadata carries the exact path for a precise read_session_file
        // follow-up, plus kind="file_summary" for downstream filtering.
        const fileChunkInputs = mergedFiles.filter(
          (f): f is SessionFileEntry & { summary: string } =>
            typeof f.summary === "string" && f.summary.trim().length > 0,
        );
        if (fileChunkInputs.length > 0) {
          const fileChunkTexts = fileChunkInputs.map(
            (f) => `${f.summary}\n\n[source: threads/${threadId}/${f.path}]`,
          );
          await insertEpisodicMemoryChunks(
            threadId,
            userId,
            agentId,
            fileChunkTexts,
            embedder.embedText,
            {
              source: "session_summarization",
              extraMetadata: (_chunk, i) => ({
                kind: "file_summary",
                sessionFilePath: fileChunkInputs[i].path,
              }),
            },
          );
        }

        logger.info("Session summarization complete — summary and chunks persisted", {
          threadId,
          fileChunks: fileChunkInputs.length,
        });

        return {
          summaryLen: result.summary.length,
          chunkCount: result.chunks.length,
          fileCount: mergedFiles.length,
          summary: result.summary.substring(0, 500),
        } as any;
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

/**
 * Renders the `state.sessionFiles` array as a `<files>` block for the
 * summarisation prompt. Returns "" when there are no files so the caller can
 * skip emitting the block entirely.
 */
function formatSessionFilesBlock(files: SessionFileEntry[] | undefined): string {
  if (!files || files.length === 0) return "";
  const rows = files.map((f) => {
    const meta = [`bytes=${f.bytes}`, `updatedAt=${f.updatedAt}`];
    if (f.source) meta.push(`source=${f.source}`);
    return `- ${f.path}  (${meta.join(", ")})`;
  });
  return [
    "<files>",
    "Files written into this thread's session workspace during the conversation.",
    "Emit one entry in `fileSummaries` per path below, using the path verbatim:",
    ...rows,
    "</files>",
  ].join("\n");
}

/**
 * Merges LLM-emitted file summaries onto the captured manifest by path.
 * Drops any LLM entry whose `path` does not appear in `captured` — the
 * captured list is ground truth, so a hallucinated path means the model
 * invented a file that was never written.
 */
function mergeFileSummaries(
  captured: SessionFileEntry[] | undefined,
  emitted: { path: string; summary: string }[] | undefined,
): SessionFileEntry[] {
  if (!captured || captured.length === 0) return [];
  if (!emitted || emitted.length === 0) return [...captured];
  const summaryByPath = new Map<string, string>();
  for (const e of emitted) {
    if (e?.path && typeof e.summary === "string") {
      summaryByPath.set(e.path, e.summary.trim());
    }
  }
  return captured.map((f) => {
    const s = summaryByPath.get(f.path);
    return s ? { ...f, summary: s } : f;
  });
}
