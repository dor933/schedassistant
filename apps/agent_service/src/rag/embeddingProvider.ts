/** Extend when adding non-OpenAI embedding backends. */
import { EmbeddingProvider } from "../types/providers";

/**
 * Resolves the API key for an embedding provider.
 *
 * Embeddings run outside of any agent/org context (they're a system-level
 * concern used for RAG indexing across all tenants), so they deliberately do
 * NOT use the per-org vendor key table. The operator supplies a single
 * embeddings key via OPENAI_API_KEY.
 *
 * If/when embeddings need to be billed per-org, the caller will need to
 * start threading an organizationId through and this should switch to
 * `resolveOrgVendorByOrg`.
 */
export async function resolveEmbeddingProviderApiKey(
  provider: EmbeddingProvider,
): Promise<string | undefined> {
  switch (provider) {
    case "openai":
      return process.env.OPENAI_API_KEY?.trim() || undefined;
  }
}
