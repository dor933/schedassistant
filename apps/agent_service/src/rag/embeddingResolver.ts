/**
 * Per-org embedding configuration resolver (slice 15).
 *
 * Replaces the platform-wide `EMBEDDING_PROVIDER` env var + hardcoded
 * `text-embedding-3-small` model. Every embedder built by the runtime
 * goes through this — given an `organizationId`, it returns the four
 * facts needed to construct an embedder: vendor slug, model slug,
 * dimension, and credential.
 *
 * Throws structured errors so callers (the chat entry point in user_app
 * and the agent_service RAG path) can surface the right "your admin
 * hasn't finished setup" message:
 *   - `EMBEDDING_NOT_CONFIGURED` → org hasn't picked a model yet
 *   - `EMBEDDING_KEY_MISSING`    → model picked, but no usable key on
 *                                  the matching vendor row
 *   - `EMBEDDING_DIMENSION_MISMATCH` → frozen dim ≠ catalog row's dim
 *                                     (catalog drift; data corruption
 *                                     guard, shouldn't happen)
 *
 * Key resolution priority (per slice-15 ratified decisions):
 *   1. `keyType: 'embedding'` row for the model's vendor
 *   2. `keyType: 'api_key'` row for the same vendor (ergonomics: one
 *      OpenAI key works for chat + embeddings unless the admin opts
 *      to bill them separately)
 * `oauth_token` and `auth_object` rows are NOT used here — embedding
 * APIs need a plain string credential and those rows describe Claude /
 * Codex CLI authentication shapes that don't apply to the embedding
 * endpoints.
 */

import {
  Agent,
  EmbeddingModel,
  Organization,
  OrganizationVendorApiKey,
  Vendor,
} from "@scheduling-agent/database";

export class EmbeddingNotConfiguredError extends Error {
  readonly code = "EMBEDDING_NOT_CONFIGURED";
  constructor(organizationId: string) {
    super(
      `Organization ${organizationId} has not configured an embedding model. ` +
        `A super admin must pick one in Admin → Embedding Model before ` +
        `agents can run.`,
    );
  }
}

export class EmbeddingKeyMissingError extends Error {
  readonly code = "EMBEDDING_KEY_MISSING";
  constructor(organizationId: string, vendorSlug: string) {
    super(
      `Organization ${organizationId} has no usable credential for ` +
        `embedding vendor "${vendorSlug}". Upload either an embedding-typed ` +
        `or api_key-typed row in Admin → Vendor API Keys.`,
    );
  }
}

export class EmbeddingDimensionMismatchError extends Error {
  readonly code = "EMBEDDING_DIMENSION_MISMATCH";
  constructor(organizationId: string, frozen: number, catalogDim: number) {
    super(
      `Organization ${organizationId} has frozen embedding_dimension=${frozen} ` +
        `but the chosen model's catalog row reports dimension=${catalogDim}. ` +
        `This indicates catalog drift; refusing to embed.`,
    );
  }
}

export interface ResolvedOrgEmbedding {
  organizationId: string;
  vendorSlug: string;
  modelSlug: string;
  dimension: number;
  apiKey: string;
  /** Discriminator for which vendor-keys row was actually used — useful
   *  for logs/telemetry, not the runtime path. */
  keySource: "embedding" | "api_key";
}

/**
 * Resolves the org's embedding configuration. Throws on any of the
 * three setup-incomplete cases — never returns null.
 */
export async function resolveOrgEmbedding(
  organizationId: string,
): Promise<ResolvedOrgEmbedding> {
  const org = await Organization.findByPk(organizationId, {
    attributes: ["id", "embeddingModelId", "embeddingDimension"],
  });
  if (!org || !org.embeddingModelId) {
    throw new EmbeddingNotConfiguredError(organizationId);
  }

  const model = await EmbeddingModel.findByPk(org.embeddingModelId, {
    attributes: ["id", "slug", "dimension", "vendorId"],
  });
  if (!model) {
    // Model row was deleted under us — treat as "not configured" so
    // admins are pushed back to the picker.
    throw new EmbeddingNotConfiguredError(organizationId);
  }

  // Freeze-on-first-set check. The org's dimension snapshot must match
  // the catalog row. If the catalog row's dim was edited (slug reused),
  // this catches the drift before we'd write malformed vectors.
  if (
    org.embeddingDimension !== null &&
    org.embeddingDimension !== model.dimension
  ) {
    throw new EmbeddingDimensionMismatchError(
      organizationId,
      org.embeddingDimension,
      model.dimension,
    );
  }

  const vendor = await Vendor.findByPk(model.vendorId, {
    attributes: ["id", "slug"],
  });
  if (!vendor) {
    throw new EmbeddingNotConfiguredError(organizationId);
  }

  // Key resolution: 'embedding' row preferred, fall back to 'api_key'
  // row for the same vendor.
  const rows = await OrganizationVendorApiKey.findAll({
    where: { organizationId, vendorId: vendor.id },
    attributes: ["apiKey", "keyType"],
  });
  const embeddingRow = rows.find(
    (r) =>
      r.keyType === "embedding" &&
      typeof r.apiKey === "string" &&
      r.apiKey.length > 0,
  );
  const apiKeyRow = rows.find(
    (r) =>
      r.keyType === "api_key" &&
      typeof r.apiKey === "string" &&
      r.apiKey.length > 0,
  );
  const picked = embeddingRow ?? apiKeyRow;
  if (!picked || !picked.apiKey) {
    throw new EmbeddingKeyMissingError(organizationId, vendor.slug);
  }

  return {
    organizationId,
    vendorSlug: vendor.slug,
    modelSlug: model.slug,
    dimension: model.dimension,
    apiKey: picked.apiKey,
    keySource: picked.keyType === "embedding" ? "embedding" : "api_key",
  };
}

/**
 * Convenience: resolves the agent's organization first, then its
 * embedding config. Mirrors `getEmbedderForAgent`'s old behaviour but
 * surfaces the structured errors above instead of the generic string.
 */
export async function resolveOrgEmbeddingForAgent(
  agentId: string | null | undefined,
): Promise<ResolvedOrgEmbedding> {
  if (!agentId) {
    throw new Error("Cannot resolve embedding config without an agent id.");
  }
  const agent = await Agent.findByPk(agentId, {
    attributes: ["organizationId"],
  });
  if (!agent?.organizationId) {
    throw new Error(
      `Agent ${agentId} has no organization; cannot resolve embedding config.`,
    );
  }
  return resolveOrgEmbedding(agent.organizationId);
}
