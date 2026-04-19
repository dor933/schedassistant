/** Extend when adding non-OpenAI embedding backends. */
import { OrganizationVendorApiKey, Vendor } from "@scheduling-agent/database";
import { EmbeddingProvider } from "../types/providers";

/**
 * Resolves the API key for an embedding provider scoped to a specific
 * organization, by reading the key the org uploaded for the matching vendor
 * (e.g. provider="openai" → vendor with slug "openai"). This matches the
 * per-org billing model used by chat LLM invocations via `resolveOrgVendor`
 * — embeddings are a user-facing feature and must be billed to the tenant,
 * not to a platform-wide env variable.
 *
 * Returns undefined if either the vendor row or the per-org key is missing;
 * callers should surface a clear "your org has not uploaded an OpenAI key"
 * error rather than silently falling back to a shared credential.
 */
export async function resolveEmbeddingProviderApiKeyForOrg(
  organizationId: string,
  provider: EmbeddingProvider,
): Promise<string | undefined> {
  const vendor = await Vendor.findOne({
    where: { slug: provider },
    attributes: ["id"],
  });
  if (!vendor) return undefined;

  const ovk = await OrganizationVendorApiKey.findOne({
    where: { organizationId, vendorId: vendor.id },
    attributes: ["apiKey"],
  });
  return ovk?.apiKey?.trim() || undefined;
}
