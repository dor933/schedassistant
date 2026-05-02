import { OrganizationVendorApiKey, Vendor } from "@scheduling-agent/database";
import type { OrganizationVendorKeyType } from "@scheduling-agent/database/dist/models/OrganizationVendorApiKey";
import type { UserId } from "@scheduling-agent/types";
import { getIO } from "../../sockets/server/socketServer";
import { logger } from "../../logger";

const ALLOWED_KEY_TYPES: readonly OrganizationVendorKeyType[] = [
  "api_key",
  "oauth_token",
  "auth_object",
  "embedding",
] as const;

function isAllowedKeyType(value: unknown): value is OrganizationVendorKeyType {
  return (
    typeof value === "string" &&
    (ALLOWED_KEY_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Validates the structure of a Codex `auth.json` blob before persisting.
 * Same contract as the legacy `codexAuthJson.service.validateBlob` — must
 * carry at least one usable credential (OPENAI_API_KEY or
 * tokens.access_token) and `last_refresh`, when present, must parse as a
 * date.
 */
function validateAuthObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(
      new Error("auth_object must be a JSON object — paste the full auth.json contents."),
      { status: 400 },
    );
  }
  const blob = value as Record<string, unknown>;
  const apiKey = typeof blob.OPENAI_API_KEY === "string" ? blob.OPENAI_API_KEY.trim() : "";
  const tokens = blob.tokens as { access_token?: unknown } | undefined;
  const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token.trim() : "";
  if (!apiKey && !accessToken) {
    throw Object.assign(
      new Error(
        "auth_object must contain either a non-null OPENAI_API_KEY or tokens.access_token. Run `codex login` again and re-export.",
      ),
      { status: 400 },
    );
  }
  if (
    typeof blob.last_refresh === "string" &&
    blob.last_refresh.trim().length > 0 &&
    Number.isNaN(Date.parse(blob.last_refresh))
  ) {
    throw Object.assign(
      new Error(`auth_object.last_refresh ("${blob.last_refresh}") is not a parseable timestamp.`),
      { status: 400 },
    );
  }
  return blob;
}

function maskAuthObject(blob: Record<string, unknown> | null): string {
  if (!blob) return "";
  const tokens = blob.tokens as { access_token?: unknown; account_id?: unknown } | undefined;
  const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : null;
  const apiKey = typeof blob.OPENAI_API_KEY === "string" ? blob.OPENAI_API_KEY : null;
  const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : null;
  if (accessToken) {
    const masked =
      accessToken.length <= 8
        ? "••••"
        : `${accessToken.slice(0, 4)}••••${accessToken.slice(-4)}`;
    return accountId ? `${masked} (acct …${accountId.slice(-8)})` : masked;
  }
  if (apiKey) {
    return apiKey.length <= 8
      ? "••••"
      : `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}`;
  }
  return "(configured)";
}

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
      attributes: ["vendorId", "apiKey", "authObject", "keyType", "updatedAt"],
    });
    // Group by vendor — each vendor may now have up to one row per key_type.
    const keysByVendor = new Map<
      string,
      { keyType: OrganizationVendorKeyType; masked: string; updatedAt: Date | null }[]
    >();
    for (const k of configured) {
      const list = keysByVendor.get(k.vendorId) ?? [];
      // Mask differently per credential type. `auth_object` has no
      // single string to display — we surface a token preview drawn
      // from the structured payload.
      const masked =
        k.keyType === "auth_object"
          ? maskAuthObject(k.authObject)
          : maskKey(k.apiKey ?? "");
      list.push({
        keyType: k.keyType,
        masked,
        updatedAt: k.updatedAt ?? null,
      });
      keysByVendor.set(k.vendorId, list);
    }
    return vendors.map((v) => {
      const keys = keysByVendor.get(v.id) ?? [];
      return {
        vendorId: v.id,
        vendorName: v.name,
        vendorSlug: v.slug,
        hasApiKey: keys.length > 0,
        // Backwards-compat: pre-keyType clients only render `masked` /
        // `updatedAt` for one credential. Surface the most recently updated
        // one in those legacy fields, plus the full per-keyType breakdown
        // in `keys` for the new admin UI.
        masked: keys.length > 0 ? keys[0].masked : null,
        updatedAt: keys.length > 0 ? keys[0].updatedAt : null,
        keys,
      };
    });
  }

  /**
   * Create or replace the caller org's credential for one vendor + key_type.
   *
   * Each (org, vendor, key_type) tuple holds at most one row. If a row for
   * the same tuple already exists, the new value REPLACES it (the unique
   * index in migration 120 + the explicit find-then-update ensure no
   * duplicates can land). The same (org, vendor) may carry both an
   * `'api_key'` row AND an `'oauth_token'` row — uploading one does not
   * disturb the other.
   *
   * Passing an empty/whitespace string is rejected (use `remove` to clear).
   * Defaults `keyType` to `'api_key'` for backwards compatibility with
   * older clients that do not send the field.
   */
  async set(
    tenantOrganizationId: string,
    vendorId: string,
    payload: { apiKey?: string; authObject?: unknown },
    actorId: UserId,
    keyType: OrganizationVendorKeyType = "api_key",
  ) {
    if (!isAllowedKeyType(keyType)) {
      throw Object.assign(
        new Error(`keyType must be one of: ${ALLOWED_KEY_TYPES.join(", ")}.`),
        { status: 400 },
      );
    }

    // Resolve the credential payload per key_type. Exactly one of
    // apiKey / authObject must be present, matching the row-level
    // CHECK constraint (migration 127).
    let apiKeyValue: string | null = null;
    let authObjectValue: Record<string, unknown> | null = null;
    if (keyType === "auth_object") {
      if (payload.authObject === undefined || payload.authObject === null) {
        throw Object.assign(
          new Error("authObject is required when keyType is 'auth_object'."),
          { status: 400 },
        );
      }
      // Admin UI may send the blob as a string from a textarea; parse it.
      let parsed: unknown = payload.authObject;
      if (typeof parsed === "string") {
        try {
          parsed = JSON.parse(parsed);
        } catch (err: any) {
          throw Object.assign(
            new Error(`auth_object is not valid JSON: ${err?.message ?? err}`),
            { status: 400 },
          );
        }
      }
      authObjectValue = validateAuthObject(parsed);
    } else {
      const trimmed = payload.apiKey?.trim();
      if (!trimmed) {
        throw Object.assign(
          new Error("apiKey is required and cannot be empty. To clear a key, use DELETE."),
          { status: 400 },
        );
      }
      apiKeyValue = trimmed;
    }

    const vendor = await Vendor.findByPk(vendorId, { attributes: ["id", "name", "slug"] });
    if (!vendor) {
      throw Object.assign(new Error("Vendor not found."), { status: 404 });
    }

    // Replace-on-conflict for the (org, vendor, keyType) tuple. If the same
    // tuple already exists, overwrite the value — admins re-uploading a
    // rotated credential for the same kind expect the old one to be gone,
    // not a unique-index violation. Other key_types for the same
    // (org, vendor) are left untouched.
    const existing = await OrganizationVendorApiKey.findOne({
      where: {
        organizationId: tenantOrganizationId,
        vendorId: vendor.id,
        keyType,
      },
    });
    if (existing) {
      await existing.update({
        apiKey: apiKeyValue,
        authObject: authObjectValue,
      });
    } else {
      await OrganizationVendorApiKey.create({
        organizationId: tenantOrganizationId,
        vendorId: vendor.id,
        apiKey: apiKeyValue,
        authObject: authObjectValue,
        keyType,
      });
    }

    const label =
      keyType === "auth_object"
        ? "Codex auth.json"
        : keyType === "oauth_token"
          ? "OAuth token"
          : "API key";
    this.broadcast(
      tenantOrganizationId,
      "org_vendor_api_key_updated",
      `${label} set for ${vendor.name}`,
      { vendorId: vendor.id, vendorName: vendor.name, keyType, hasApiKey: true },
      actorId,
    );

    return {
      vendorId: vendor.id,
      vendorName: vendor.name,
      vendorSlug: vendor.slug,
      keyType,
      hasApiKey: true,
      masked:
        keyType === "auth_object"
          ? maskAuthObject(authObjectValue)
          : maskKey(apiKeyValue ?? ""),
    };
  }

  /**
   * Remove the caller org's credential(s) for one vendor.
   *
   * `keyType` is optional:
   *   - When omitted → removes BOTH credential rows (api_key + oauth_token)
   *     for that (org, vendor). Matches the legacy single-row UX.
   *   - When provided → removes only the row matching that key_type, leaves
   *     the other one intact.
   *
   * Idempotent — returns 200 even when no row matched.
   */
  async remove(
    tenantOrganizationId: string,
    vendorId: string,
    actorId: UserId,
    keyType?: OrganizationVendorKeyType,
  ) {
    const vendor = await Vendor.findByPk(vendorId, { attributes: ["id", "name", "slug"] });
    if (!vendor) {
      throw Object.assign(new Error("Vendor not found."), { status: 404 });
    }
    if (keyType !== undefined && !isAllowedKeyType(keyType)) {
      throw Object.assign(
        new Error(
          `keyType, when provided, must be one of: ${ALLOWED_KEY_TYPES.join(", ")}.`,
        ),
        { status: 400 },
      );
    }
    const where: Record<string, unknown> = {
      organizationId: tenantOrganizationId,
      vendorId: vendor.id,
    };
    if (keyType) where.keyType = keyType;

    const deleted = await OrganizationVendorApiKey.destroy({ where });

    if (deleted > 0) {
      const label =
        keyType === "auth_object"
          ? "Codex auth.json"
          : keyType === "oauth_token"
            ? "OAuth token"
            : keyType === "api_key"
              ? "API key"
              : null;
      this.broadcast(
        tenantOrganizationId,
        "org_vendor_api_key_updated",
        label
          ? `${label} removed for ${vendor.name}`
          : `All credentials removed for ${vendor.name}`,
        { vendorId: vendor.id, vendorName: vendor.name, keyType: keyType ?? null, hasApiKey: false },
        actorId,
      );
    }
    return {
      vendorId: vendor.id,
      vendorName: vendor.name,
      vendorSlug: vendor.slug,
      keyType: keyType ?? null,
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
