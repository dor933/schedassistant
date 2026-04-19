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
  /** null when the org exists but hasn't uploaded a key for this vendor yet. */
  apiKey: string | null;
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

  const ovk = await OrganizationVendorApiKey.findOne({
    where: { organizationId: agent.organizationId, vendorId: vendor.id },
    attributes: ["apiKey"],
  });

  return {
    vendorId: vendor.id,
    vendorSlug: vendor.slug,
    modelName: model.name,
    apiKey: ovk?.apiKey ?? null,
  };
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

  const ovk = await OrganizationVendorApiKey.findOne({
    where: { organizationId, vendorId: vendor.id },
    attributes: ["apiKey"],
  });

  return {
    vendorId: vendor.id,
    vendorSlug: vendor.slug,
    modelName: model.name,
    apiKey: ovk?.apiKey ?? null,
  };
}
