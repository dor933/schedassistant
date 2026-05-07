import {
  Agent,
  LLMModel,
  OrganizationVendorApiKey,
  Vendor,
} from "@scheduling-agent/database";

/**
 * Resolves the vendor slug and organization-scoped API key for a given
 * `(modelSlug, agentId)` pair. Every LLM invocation in the agent service
 * runs through this helper so the API key is always looked up per-org —
 * never a platform-wide shared credential.
 *
 * Returns null if any of:
 *  - the model slug isn't in the catalog
 *  - the agent has no organization (shouldn't happen for tenant agents)
 *  - the organization hasn't uploaded a key for this vendor yet
 *
 * Distinguishing *why* resolution failed is the caller's job: the two
 * interesting cases are "unknown model" vs "org hasn't configured a key",
 * which they can tell apart by checking the `apiKey` field on a non-null
 * result (model known, key missing) vs a null return (model unknown).
 */
export interface ResolvedOrgVendor {
  vendorId: string;
  vendorSlug: string;
  modelName: string;
  /**
   * Resolved per-org credential. null when the org has not uploaded any
   * credential for this vendor yet.
   *
   * Selection priority when multiple credential rows exist for the same
   * (org, vendor) — currently up to two: one `api_key` and one
   * `oauth_token`:
   *   1. `oauth_token` wins for Anthropic (Claude Code OAuth tokens carry
   *      Pro/Max subscription billing, which the user has standardised
   *      on for SDK runtime calls).
   *   2. Otherwise (other vendors, or no oauth_token row) → `api_key`.
   */
  apiKey: string | null;
  /** Discriminator for `apiKey`. Determines how the runtime presents the
   *  credential to the LLM SDK (env var, auth header). null mirrors apiKey
   *  when no credential exists. */
  keyType: "api_key" | "oauth_token" | null;
}

export async function resolveOrgVendor(
  modelSlug: string,
  agentId: string | null,
): Promise<ResolvedOrgVendor | null> {
  if (!agentId) return null;

  const model = await LLMModel.findOne({
    where: { slug: modelSlug },
    attributes: ["id", "name", "vendorId"],
  });
  if (!model) return null;

  const vendor = await Vendor.findByPk(model.vendorId, {
    attributes: ["id", "slug"],
  });
  if (!vendor) return null;

  const agent = await Agent.findByPk(agentId, {
    attributes: ["organizationId"],
  });
  if (!agent?.organizationId) return null;

  // Load every credential row for this (org, vendor) — there may be one or
  // two (one per key_type). Pick OAuth first per the priority rule.
  const rows = await OrganizationVendorApiKey.findAll({
    where: { organizationId: agent.organizationId, vendorId: vendor.id },
    attributes: ["apiKey", "keyType"],
  });
  const picked = pickPreferredCredential(rows);

  return {
    vendorId: vendor.id,
    vendorSlug: vendor.slug,
    modelName: model.name,
    apiKey: picked?.apiKey ?? null,
    keyType: picked?.keyType ?? null,
  };
}

/**
 * Selects the SIMPLE-STRING credential row to use when an (org, vendor)
 * has more than one. OAuth tokens win over API keys because they carry
 * subscription-tier billing (Pro/Max). Rows that store a structured
 * `auth_object` (Codex CLI's auth.json) are SKIPPED here — the
 * Codex SDK runner looks them up separately via
 * `loadCodexAuthObjectForAgentWithOrg` and materialises the blob into a
 * Codex-compatible $HOME. Skipping them avoids returning a row whose
 * `api_key` is null (post-migration-127 it can be).
 */
function pickPreferredCredential(
  rows: {
    apiKey: string | null;
    keyType: "api_key" | "oauth_token" | "auth_object" | "embedding";
  }[],
): { apiKey: string; keyType: "api_key" | "oauth_token" } | null {
  // Embedding-typed rows belong to the embedding pipeline only — they
  // must NOT be selected here. Same reason auth_object is skipped:
  // wrong shape for chat-LLM callers.
  const stringRows = rows.filter(
    (r): r is { apiKey: string; keyType: "api_key" | "oauth_token" } =>
      typeof r.apiKey === "string" &&
      r.apiKey.length > 0 &&
      (r.keyType === "api_key" || r.keyType === "oauth_token"),
  );
  if (stringRows.length === 0) return null;
  const oauth = stringRows.find((r) => r.keyType === "oauth_token");
  if (oauth) return oauth;
  const apiKey = stringRows.find((r) => r.keyType === "api_key");
  return apiKey ?? stringRows[0];
}

/**
 * Convenience variant for callers that already hold an `organizationId`
 * and shouldn't re-resolve it from an agent — e.g. the deep-agent worker,
 * which resolves the executor agent's org directly from its record.
 */
export async function resolveOrgVendorByOrg(
  modelSlug: string,
  organizationId: string | null,
): Promise<ResolvedOrgVendor | null> {
  if (!organizationId) return null;

  const model = await LLMModel.findOne({
    where: { slug: modelSlug },
    attributes: ["id", "name", "vendorId"],
  });
  if (!model) return null;

  const vendor = await Vendor.findByPk(model.vendorId, {
    attributes: ["id", "slug"],
  });
  if (!vendor) return null;

  const rows = await OrganizationVendorApiKey.findAll({
    where: { organizationId, vendorId: vendor.id },
    attributes: ["apiKey", "keyType"],
  });
  const picked = pickPreferredCredential(rows);

  return {
    vendorId: vendor.id,
    vendorSlug: vendor.slug,
    modelName: model.name,
    apiKey: picked?.apiKey ?? null,
    keyType: picked?.keyType ?? null,
  };
}
