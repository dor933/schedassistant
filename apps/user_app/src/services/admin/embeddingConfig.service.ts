/**
 * Per-org embedding configuration admin surface (slice 15).
 *
 * Three operations:
 *  1. `listCatalog()` — read-only catalog of supported embedding models,
 *     each with vendor + dimension + slug. Used by the admin picker.
 *  2. `getOrgChoice(orgId)` — current pick (or null) for an org plus the
 *     setup status, so the admin UI can show "current model:" and
 *     "missing key" pills.
 *  3. `setOrgChoice(orgId, modelId)` — sets the org's choice. Refuses
 *     dimension-changing switches (slice-15 dim-freeze rule); the only
 *     supported mode of changing dim is to drop the column to NULL,
 *     which is gated behind a separate "wipe & re-embed" flow we have
 *     not built yet.
 *
 * The agent_service in-memory embedder cache is invalidated remotely
 * via the existing socket broadcast pattern — the client refreshes the
 * setup-status badge and the agent_service rebuilds its embedder on
 * the next call (cache key includes `modelSlug`, so a new pick falls
 * out of the cache automatically).
 */

import {
  EmbeddingModel,
  Organization,
  Vendor,
} from "@scheduling-agent/database";
import type { UserId } from "@scheduling-agent/types";
import { getIO } from "../../sockets/server/socketServer";
import { logger } from "../../logger";
import {
  organizationSetupService,
  type OrganizationSetupStatus,
} from "../organizationSetup.service";

export interface EmbeddingCatalogEntry {
  id: string;
  slug: string;
  name: string;
  dimension: number;
  vendor: { id: string; slug: string; name: string };
}

export interface OrgEmbeddingChoice {
  /** Null when the org hasn't picked yet. */
  current: EmbeddingCatalogEntry | null;
  /** Frozen dimension snapshot — once set, future picks must match. */
  frozenDimension: number | null;
  /** Same shape as `OrganizationSetupStatus`. The admin UI renders the
   *  missing-piece chips off this directly. */
  setup: OrganizationSetupStatus;
}

export class EmbeddingConfigService {
  async listCatalog(): Promise<EmbeddingCatalogEntry[]> {
    const rows = await EmbeddingModel.findAll({
      attributes: ["id", "slug", "name", "dimension", "vendorId"],
      order: [
        ["dimension", "ASC"],
        ["name", "ASC"],
      ],
    });
    if (rows.length === 0) return [];
    const vendorIds = Array.from(new Set(rows.map((r) => r.vendorId)));
    const vendors = await Vendor.findAll({
      where: { id: vendorIds },
      attributes: ["id", "slug", "name"],
    });
    const vendorById = new Map(vendors.map((v) => [v.id, v]));
    return rows
      .map((r) => {
        const v = vendorById.get(r.vendorId);
        if (!v) return null;
        return {
          id: r.id,
          slug: r.slug,
          name: r.name,
          dimension: r.dimension,
          vendor: { id: v.id, slug: v.slug, name: v.name },
        };
      })
      .filter((x): x is EmbeddingCatalogEntry => x !== null);
  }

  async getOrgChoice(organizationId: string): Promise<OrgEmbeddingChoice> {
    const [org, setup] = await Promise.all([
      Organization.findByPk(organizationId, {
        attributes: ["id", "embeddingModelId", "embeddingDimension"],
      }),
      organizationSetupService.getStatus(organizationId),
    ]);
    if (!org) {
      throw Object.assign(new Error("Organization not found."), { status: 404 });
    }
    let current: EmbeddingCatalogEntry | null = null;
    if (org.embeddingModelId) {
      const model = await EmbeddingModel.findByPk(org.embeddingModelId, {
        attributes: ["id", "slug", "name", "dimension", "vendorId"],
      });
      if (model) {
        const vendor = await Vendor.findByPk(model.vendorId, {
          attributes: ["id", "slug", "name"],
        });
        if (vendor) {
          current = {
            id: model.id,
            slug: model.slug,
            name: model.name,
            dimension: model.dimension,
            vendor: { id: vendor.id, slug: vendor.slug, name: vendor.name },
          };
        }
      }
    }
    return {
      current,
      frozenDimension: org.embeddingDimension,
      setup,
    };
  }

  /**
   * Sets the org's embedding model. Honours the dim-freeze rule:
   *  - First pick: writes both `embedding_model_id` and
   *    `embedding_dimension` (the freeze).
   *  - Subsequent pick with same dim: updates only
   *    `embedding_model_id` (dimension snapshot unchanged).
   *  - Subsequent pick with different dim: 409 with a clear "you'd
   *    have to wipe and re-embed" message. We intentionally don't
   *    auto-wipe here — losing every episodic-memory chunk is too
   *    consequential for a single button press.
   */
  async setOrgChoice(
    organizationId: string,
    modelId: string,
    actorId: UserId,
  ): Promise<OrgEmbeddingChoice> {
    const org = await Organization.findByPk(organizationId);
    if (!org) {
      throw Object.assign(new Error("Organization not found."), { status: 404 });
    }
    const model = await EmbeddingModel.findByPk(modelId, {
      attributes: ["id", "dimension", "slug"],
    });
    if (!model) {
      throw Object.assign(new Error("Embedding model not found."), {
        status: 404,
      });
    }

    if (
      org.embeddingDimension !== null &&
      org.embeddingDimension !== model.dimension
    ) {
      throw Object.assign(
        new Error(
          `Refusing to switch embedding model: dimension would change ` +
            `from ${org.embeddingDimension} to ${model.dimension}. The ` +
            `episodic memory store has vectors at the existing dimension, ` +
            `which would become unreadable. To switch dimensions you must ` +
            `wipe episodic memory first (admin "Reset embeddings" flow — ` +
            `not yet implemented).`,
        ),
        { status: 409 },
      );
    }

    await org.update({
      embeddingModelId: model.id,
      embeddingDimension: model.dimension,
    });

    try {
      getIO().emit("admin:change", {
        type: "org_embedding_model_changed",
        message: `Embedding model set to ${model.slug}.`,
        data: { organizationId, modelId: model.id, modelSlug: model.slug },
        actorId,
      });
    } catch (err) {
      logger.error("broadcast org_embedding_model_changed failed", {
        error: String(err),
      });
    }

    return this.getOrgChoice(organizationId);
  }
}

export const embeddingConfigService = new EmbeddingConfigService();
