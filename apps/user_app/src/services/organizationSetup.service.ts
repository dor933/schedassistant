/**
 * Organization setup-status (slice 15).
 *
 * The gate that decides whether an org is "ready" enough to run agents.
 * Returns a structured `{ complete, missing }` so callers can either
 * surface a 412 to the chat path or render an actionable banner in the
 * admin UI.
 *
 * Currently the only gate is "embedding configuration is set" — chat
 * vendor keys are NOT a setup gate because per-agent vendor resolution
 * already throws a clear "your org has not configured a key for X" at
 * invocation time. Embeddings are different: they're an invisible RAG
 * dependency, so the user-visible failure mode is much worse without
 * an explicit pre-check.
 *
 * As more cross-cutting prerequisites land (future: `library_required`,
 * `agent_count >= 1`, etc.) extend `MissingPiece` and `getStatus`.
 */

import {
  EmbeddingModel,
  Organization,
  OrganizationVendorApiKey,
  Vendor,
} from "@scheduling-agent/database";

export type MissingPiece = "embedding_model" | "embedding_key";

export interface OrganizationSetupStatus {
  organizationId: string;
  /** True when no `MissingPiece` remains. Used as the boolean flag on
   *  `/auth/me` and `/auth/login` responses. */
  complete: boolean;
  missing: MissingPiece[];
  /** When the org has picked a model, surface the slug so the admin UI
   *  can render "current: text-embedding-3-small". Null otherwise. */
  embeddingModelSlug: string | null;
  /** Same for the chosen vendor — useful for error wording. */
  embeddingVendorSlug: string | null;
}

export class OrganizationSetupService {
  /**
   * Checks whether `organizationId` has the prerequisites needed for
   * agent invocations. Cheap (3 short queries) so the chat hot path
   * can call it inline.
   */
  async getStatus(organizationId: string): Promise<OrganizationSetupStatus> {
    const org = await Organization.findByPk(organizationId, {
      attributes: ["id", "embeddingModelId"],
    });
    if (!org) {
      // Should be unreachable — the auth middleware already proved the
      // org exists. Fail closed.
      return {
        organizationId,
        complete: false,
        missing: ["embedding_model", "embedding_key"],
        embeddingModelSlug: null,
        embeddingVendorSlug: null,
      };
    }

    const missing: MissingPiece[] = [];
    let embeddingModelSlug: string | null = null;
    let embeddingVendorSlug: string | null = null;

    if (!org.embeddingModelId) {
      missing.push("embedding_model");
      // No model → no need to check key (admin sees the model picker
      // first; the key check shows up only after they've chosen one).
      return {
        organizationId,
        complete: false,
        missing,
        embeddingModelSlug: null,
        embeddingVendorSlug: null,
      };
    }

    const model = await EmbeddingModel.findByPk(org.embeddingModelId, {
      attributes: ["slug", "vendorId"],
    });
    if (!model) {
      // Catalog drift — treat as missing so admin re-picks.
      missing.push("embedding_model");
      return {
        organizationId,
        complete: false,
        missing,
        embeddingModelSlug: null,
        embeddingVendorSlug: null,
      };
    }
    embeddingModelSlug = model.slug;

    const vendor = await Vendor.findByPk(model.vendorId, {
      attributes: ["id", "slug"],
    });
    embeddingVendorSlug = vendor?.slug ?? null;

    if (vendor) {
      // Key resolution mirrors `resolveOrgEmbedding`'s priority — an
      // 'embedding'-typed row counts, an 'api_key'-typed row counts as
      // fallback. Anything else (oauth_token, auth_object) does NOT
      // count for embeddings.
      const rows = await OrganizationVendorApiKey.findAll({
        where: { organizationId, vendorId: vendor.id },
        attributes: ["apiKey", "keyType"],
      });
      const usable = rows.find(
        (r) =>
          (r.keyType === "embedding" || r.keyType === "api_key") &&
          typeof r.apiKey === "string" &&
          r.apiKey.length > 0,
      );
      if (!usable) {
        missing.push("embedding_key");
      }
    } else {
      missing.push("embedding_key");
    }

    return {
      organizationId,
      complete: missing.length === 0,
      missing,
      embeddingModelSlug,
      embeddingVendorSlug,
    };
  }
}

/** Singleton — no per-request state, safe to reuse across handlers. */
export const organizationSetupService = new OrganizationSetupService();
