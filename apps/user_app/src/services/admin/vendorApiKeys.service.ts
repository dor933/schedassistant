import { OrganizationVendorApiKey, Vendor } from "@scheduling-agent/database";
import type { UserId } from "@scheduling-agent/types";
import { getIO } from "../../sockets/server/socketServer";
import { logger } from "../../logger";

/**
 * Org-scoped vendor API keys.
 *
 * Each organization uploads its own key per vendor (OpenAI, Anthropic,
 * Google, …). The agent_service reads these keys at invocation time through
 * `resolveOrgVendor(modelSlug, agentId)` — there is no global/platform
 * fallback any more.
 *
 * All methods here take a `tenantOrganizationId` pulled from the caller's
 * auth token (never a request body). Routes are gated by
 * `requireSuperAdmin`, so only an org's super admin can add/remove keys.
 */
export class VendorApiKeysService {
  /**
   * Lists every vendor in the catalog, joined with the caller org's key row
   * if one exists. The actual key value is NEVER returned — only whether a
   * key is configured, plus a short masked preview so an admin can tell the
   * keys apart before replacing one.
   */
  async list(tenantOrganizationId: string) {
    const vendors = await Vendor.findAll({
      attributes: ["id", "name", "slug"],
      order: [["name", "ASC"]],
    });
    const configured = await OrganizationVendorApiKey.findAll({
      where: { organizationId: tenantOrganizationId },
      attributes: ["vendorId", "apiKey", "updatedAt"],
    });
    const keyByVendor = new Map(configured.map((k) => [k.vendorId, k]));
    return vendors.map((v) => {
      const k = keyByVendor.get(v.id);
      return {
        vendorId: v.id,
        vendorName: v.name,
        vendorSlug: v.slug,
        hasApiKey: !!k,
        masked: k ? maskKey(k.apiKey) : null,
        updatedAt: k?.updatedAt ?? null,
      };
    });
  }

  /**
   * Create or replace the caller org's API key for one vendor.
   *
   * Passing an empty/whitespace string is rejected (use `remove` to clear).
   * Using upsert keeps the code simple and avoids a racy find-then-insert.
   */
  async set(
    tenantOrganizationId: string,
    vendorId: string,
    apiKey: string,
    actorId: UserId,
  ) {
    const trimmed = apiKey?.trim();
    if (!trimmed) {
      throw Object.assign(
        new Error("apiKey is required and cannot be empty. To clear a key, use DELETE."),
        { status: 400 },
      );
    }
    const vendor = await Vendor.findByPk(vendorId, { attributes: ["id", "name", "slug"] });
    if (!vendor) {
      throw Object.assign(new Error("Vendor not found."), { status: 404 });
    }

    const existing = await OrganizationVendorApiKey.findOne({
      where: { organizationId: tenantOrganizationId, vendorId: vendor.id },
    });
    if (existing) {
      await existing.update({ apiKey: trimmed });
    } else {
      await OrganizationVendorApiKey.create({
        organizationId: tenantOrganizationId,
        vendorId: vendor.id,
        apiKey: trimmed,
      });
    }

    this.broadcast(
      tenantOrganizationId,
      "org_vendor_api_key_updated",
      `API key set for ${vendor.name}`,
      { vendorId: vendor.id, vendorName: vendor.name, hasApiKey: true },
      actorId,
    );

    return {
      vendorId: vendor.id,
      vendorName: vendor.name,
      vendorSlug: vendor.slug,
      hasApiKey: true,
      masked: maskKey(trimmed),
    };
  }

  /**
   * Remove the caller org's key for one vendor. Idempotent — returning 200
   * on a non-existent row avoids 404-noise from the UI when a key was just
   * deleted by another admin.
   */
  async remove(tenantOrganizationId: string, vendorId: string, actorId: UserId) {
    const vendor = await Vendor.findByPk(vendorId, { attributes: ["id", "name", "slug"] });
    if (!vendor) {
      throw Object.assign(new Error("Vendor not found."), { status: 404 });
    }
    const deleted = await OrganizationVendorApiKey.destroy({
      where: { organizationId: tenantOrganizationId, vendorId: vendor.id },
    });

    if (deleted > 0) {
      this.broadcast(
        tenantOrganizationId,
        "org_vendor_api_key_updated",
        `API key removed for ${vendor.name}`,
        { vendorId: vendor.id, vendorName: vendor.name, hasApiKey: false },
        actorId,
      );
    }
    return {
      vendorId: vendor.id,
      vendorName: vendor.name,
      vendorSlug: vendor.slug,
      hasApiKey: false,
    };
  }

  private broadcast(
    _organizationId: string,
    type: string,
    message: string,
    data: Record<string, unknown>,
    actorId: UserId,
  ) {
    // Matches the pattern used by the other admin services (unscoped emit
    // with a "something changed, refetch" payload). The client only acts on
    // events it has standing to care about. If/when we introduce org-scoped
    // socket rooms, switch to `getIO().to(...)`.
    try {
      getIO().emit("admin:change", { type, message, data, actorId });
    } catch (err) {
      logger.error("broadcast vendor-api-key change failed", { error: String(err) });
    }
  }
}

/**
 * Show the first 4 + last 4 chars, masking everything in between. Helps an
 * admin visually confirm which key is stored without exposing the secret.
 */
function maskKey(raw: string): string {
  if (!raw) return "";
  const s = raw.trim();
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}
