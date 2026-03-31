import { OpenAIEmbeddings } from "@langchain/openai";

import {
  resolveEmbeddingProviderApiKey,
} from "./embeddingProvider";
import { EmbeddingProvider } from "../types/providers";

/** Which backend `getEmbeddingModel` uses; swap when multi-provider embeddings are wired. */
const EMBEDDING_PROVIDER: EmbeddingProvider = process.env.EMBEDDING_PROVIDER as EmbeddingProvider;

/**
 * Shared OpenAI embedding model instance.
 *
 * Uses `text-embedding-3-small` (1536 dimensions) — must match the
 * EMBEDDING_DIMENSION constant in the EpisodicMemory model and the
 * pgvector column created by migrations.
 */
let embeddingModel: OpenAIEmbeddings | null = null;

async function getEmbeddingModel(): Promise<OpenAIEmbeddings> {
  if (embeddingModel) return embeddingModel;

  const apiKey = await resolveEmbeddingProviderApiKey(EMBEDDING_PROVIDER as EmbeddingProvider);
  if (!apiKey) {
    throw new Error(
      "OPENAI_EMBEDDINGS_NO_KEY: Set a valid OpenAI API key for vendor \"openai\" in Admin, or OPENAI_API_KEY in agent_service. Embeddings are required for episodic RAG and are independent of the chat model (e.g. Claude).",
    );
  }

  embeddingModel = new OpenAIEmbeddings({
    modelName: "text-embedding-3-small",
    apiKey,
  });
  return embeddingModel;
}

/** Reset cached model so the next call re-reads the key from DB. */
export function resetEmbeddingModel(): void {
  embeddingModel = null;
}

/**
 * Embeds a single text string and returns its vector representation.
 * Used by episodic retrieval (query embedding) and session summarization
 * (chunk embedding).
 */
export async function embedText(text: string): Promise<number[]> {
  const model = await getEmbeddingModel();
  return model.embedQuery(text);
}

/**
 * Embeds multiple text strings in a single batched API call.
 * More efficient than calling `embedText` in a loop when you have
 * several chunks to embed at once (e.g. during session summarization).
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const model = await getEmbeddingModel();
  return model.embedDocuments(texts);
}
