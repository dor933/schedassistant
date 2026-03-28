import { OpenAIEmbeddings } from "@langchain/openai";
import { Vendor } from "@scheduling-agent/database";

/**
 * Shared OpenAI embedding model instance.
 *
 * Uses `text-embedding-3-small` (1536 dimensions) — must match the
 * EMBEDDING_DIMENSION constant in the EpisodicMemory model and the
 * pgvector column created by migrations.
 *
 * The API key is fetched from the database on first use.
 */
let embeddingModel: OpenAIEmbeddings | null = null;

async function getEmbeddingModel(): Promise<OpenAIEmbeddings> {
  if (embeddingModel) return embeddingModel;

  const vendor = await Vendor.findOne({ where: { slug: "openai" }, attributes: ["apiKey"] });
  const apiKey = vendor?.apiKey ?? undefined;

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
