import { OpenAIEmbeddings } from "@langchain/openai";
import { Agent } from "@scheduling-agent/database";

import { resolveEmbeddingProviderApiKeyForOrg } from "./embeddingProvider";
import { EmbeddingProvider } from "../types/providers";

/** Which backend the embedder uses; swap when multi-provider embeddings are wired. */
const EMBEDDING_PROVIDER: EmbeddingProvider =
  (process.env.EMBEDDING_PROVIDER as EmbeddingProvider) || "openai";

/**
 * Embedding API surface the rest of the codebase uses.
 *
 * Always scoped to a specific organization: the API key is looked up from
 * `organization_vendor_api_keys` for the matching vendor (e.g. "openai").
 * That makes embeddings billable to the tenant instead of to a platform-wide
 * shared credential — mirrors how `resolveOrgVendor` gates chat LLM calls.
 */
export interface Embedder {
  embedText(text: string): Promise<number[]>;
  embedTexts(texts: string[]): Promise<number[][]>;
}

/**
 * Cached OpenAI embedding model instances keyed by organization id. Per-org
 * instances are required because the API key is per-org; caching avoids a DB
 * round-trip on every embed call without sharing a key across tenants.
 *
 * Uses `text-embedding-3-small` (1536 dimensions) — must match the
 * EMBEDDING_DIMENSION constant in the EpisodicMemory model and the pgvector
 * column created by migrations.
 */
const embeddingModelsByOrg = new Map<string, OpenAIEmbeddings>();

async function getEmbeddingModelForOrg(
  organizationId: string,
): Promise<OpenAIEmbeddings> {
  const cached = embeddingModelsByOrg.get(organizationId);
  if (cached) return cached;

  const apiKey = await resolveEmbeddingProviderApiKeyForOrg(
    organizationId,
    EMBEDDING_PROVIDER,
  );
  if (!apiKey) {
    throw new Error(
      `OPENAI_EMBEDDINGS_NO_ORG_KEY: Organization ${organizationId} has not ` +
        `uploaded an API key for vendor "${EMBEDDING_PROVIDER}". A super admin ` +
        `must add one in Admin → Vendor API Keys. Embeddings are required for ` +
        `episodic RAG and are billed to the organization — there is no ` +
        `platform-wide fallback key.`,
    );
  }

  const model = new OpenAIEmbeddings({
    modelName: "text-embedding-3-small",
    apiKey,
  });
  embeddingModelsByOrg.set(organizationId, model);
  return model;
}

/** Reset cached model(s) so the next call re-reads the key from DB. */
export function resetEmbeddingModel(organizationId?: string): void {
  if (organizationId) embeddingModelsByOrg.delete(organizationId);
  else embeddingModelsByOrg.clear();
}

/**
 * Returns an `Embedder` bound to a specific organization. Call this once per
 * logical unit of work (one chat turn, one summarization, etc.) and reuse the
 * returned object for subsequent `embedText` / `embedTexts` calls — the org
 * resolution happens only once.
 */
export async function getEmbedderForOrg(
  organizationId: string,
): Promise<Embedder> {
  const model = await getEmbeddingModelForOrg(organizationId);
  return {
    embedText: (text: string) => model.embedQuery(text),
    embedTexts: (texts: string[]) => model.embedDocuments(texts),
  };
}

/**
 * Convenience: resolve the agent's organization, then return an `Embedder`
 * scoped to it. Throws if the agent is missing or has no organization.
 */
export async function getEmbedderForAgent(
  agentId: string | null | undefined,
): Promise<Embedder> {
  if (!agentId) {
    throw new Error("Cannot build an embedder without an agent id.");
  }
  const agent = await Agent.findByPk(agentId, {
    attributes: ["organizationId"],
  });
  if (!agent?.organizationId) {
    throw new Error(
      `Agent ${agentId} has no organization; cannot resolve embedding API key.`,
    );
  }
  return getEmbedderForOrg(agent.organizationId);
}
