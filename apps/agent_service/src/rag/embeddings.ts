import { OpenAIEmbeddings } from "@langchain/openai";
import { Embeddings } from "@langchain/core/embeddings";
import { Agent } from "@scheduling-agent/database";

import {
  resolveOrgEmbedding,
  type ResolvedOrgEmbedding,
} from "./embeddingResolver";
import { logger } from "../logger";

/**
 * Embedding API surface the rest of the codebase uses. (slice 15)
 *
 * Always scoped to a specific organization. The model slug, vendor, and
 * credential all come from `resolveOrgEmbedding` — there is no platform
 * default any more (the legacy `EMBEDDING_PROVIDER` env var was removed
 * at the same time). When the org hasn't picked a model OR has no
 * matching key, the resolver throws `EmbeddingNotConfiguredError` /
 * `EmbeddingKeyMissingError`; callers either propagate (background
 * jobs) or translate to a user-facing 412 (the chat entry point).
 */
export interface Embedder {
  /** Vendor.slug — for telemetry / logging. */
  readonly vendorSlug: string;
  /** EmbeddingModel.slug — same. */
  readonly modelSlug: string;
  /** Output dimension. Used by callers that need to validate column
   *  shape (e.g. detect drift before insert). */
  readonly dimension: number;
  embedText(text: string): Promise<number[]>;
  embedTexts(texts: string[]): Promise<number[][]>;
}

/**
 * Cached LangChain embedder instances keyed on `(orgId, modelSlug)`. A
 * model swap on the org row instantly invalidates the cache for that
 * org — the next call resolves and rebuilds. Cross-tenant reuse is
 * impossible because the orgId is in the cache key.
 */
const embedderCache = new Map<string, Embeddings>();

function cacheKey(orgId: string, modelSlug: string): string {
  return `${orgId}::${modelSlug}`;
}

/**
 * Builds the LangChain embedder for a vendor+model+key triple. Add
 * branches here when supporting new embedding vendors (Voyage, Cohere,
 * etc.) — each new branch needs the matching `@langchain/<vendor>`
 * package installed. We currently only ship OpenAI; voyage/cohere
 * catalog rows surface a clear "vendor not yet implemented" error so
 * admins can't silently pick something the runtime doesn't speak.
 */
function buildEmbedder(resolved: ResolvedOrgEmbedding): Embeddings {
  switch (resolved.vendorSlug) {
    case "openai":
      return new OpenAIEmbeddings({
        modelName: resolved.modelSlug,
        apiKey: resolved.apiKey,
      });
    default:
      throw new Error(
        `EMBEDDING_VENDOR_NOT_IMPLEMENTED: vendor "${resolved.vendorSlug}" ` +
          `is in the embedding_models catalog but the agent_service runtime ` +
          `has no LangChain client wired up for it. Either pick a supported ` +
          `vendor (currently: openai) or add the @langchain/<vendor> branch.`,
      );
  }
}

/** Reset cached embedder(s) so the next call re-reads the config from
 *  DB. The admin UI fires this when an admin saves a new model choice
 *  or rotates a key.  */
export function resetEmbeddingModel(organizationId?: string): void {
  if (organizationId) {
    for (const k of Array.from(embedderCache.keys())) {
      if (k.startsWith(`${organizationId}::`)) embedderCache.delete(k);
    }
  } else {
    embedderCache.clear();
  }
}

/**
 * Returns an `Embedder` bound to a specific organization. Call this once
 * per logical unit of work (one chat turn, one summarization, etc.) and
 * reuse the returned object for subsequent `embedText` / `embedTexts`
 * calls — the resolver runs once per call.
 */
export async function getEmbedderForOrg(
  organizationId: string,
): Promise<Embedder> {
  const resolved = await resolveOrgEmbedding(organizationId);
  const key = cacheKey(resolved.organizationId, resolved.modelSlug);
  let embedder = embedderCache.get(key);
  if (!embedder) {
    embedder = buildEmbedder(resolved);
    embedderCache.set(key, embedder);
    logger.info("Built embedder", {
      organizationId: resolved.organizationId,
      vendorSlug: resolved.vendorSlug,
      modelSlug: resolved.modelSlug,
      dimension: resolved.dimension,
      keySource: resolved.keySource,
    });
  }
  const built = embedder;
  return {
    vendorSlug: resolved.vendorSlug,
    modelSlug: resolved.modelSlug,
    dimension: resolved.dimension,
    embedText: (text: string) => built.embedQuery(text),
    embedTexts: (texts: string[]) => built.embedDocuments(texts),
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
