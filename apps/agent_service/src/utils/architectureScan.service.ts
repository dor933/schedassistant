/**
 * Vendor-fallback wrapper for the architecture-overview scan (slice 21).
 *
 * Replaces the legacy `runCliExecution`-based path that spawned the
 * Claude CLI as a subprocess. The scan now runs in-process via the
 * Anthropic Agent SDK with read-only built-ins (`Read`/`Glob`/`Grep`),
 * falling back to the Codex SDK with `sandboxMode: "read-only"` when
 * the organization has no Anthropic credential.
 *
 * Why a service-layer wrapper:
 *   - `repositories.service.generateArchitecture` (admin-triggered refreshes)
 *     needs vendor-resolution + fallback logic in one place.
 *   - The lower-level `runAnthropicScanCwd` / `runCodexScanCwd` helpers
 *     deliberately don't know about credentials — they accept the
 *     resolved values directly so they're testable and composable. The
 *     credential lookup (which queries `organization_vendor_api_keys`)
 *     belongs at this layer.
 */

import {
  LLMModel,
  Organization,
  OrganizationVendorApiKey,
  Vendor,
} from "@scheduling-agent/database";

import { runAnthropicScanCwd } from "../chat/anthropic/anthropicScanCwd";
import { runCodexScanCwd } from "../chat/codex/codexScanCwd";
import { logger } from "../logger";

/** Default Anthropic model for the scan. Sonnet 4.6 has the
 *  reading + reasoning chops for a folder-tree synthesis at a moderate
 *  cost. The slug must exist in the `models` catalog (shared across
 *  orgs); resolution falls through to the Codex path when it doesn't. */
const ANTHROPIC_SCAN_MODEL = "claude-sonnet-4-6";

/** Default Codex model for the fallback. */
const CODEX_SCAN_MODEL = "gpt-5";

export interface RunArchitectureScanOptions {
  /** Absolute path of the repository to scan. */
  cwd: string;
  /** User-side prompt — typically built by `buildArchitectureOverviewPrompt`. */
  prompt: string;
  /** Organization whose per-org credentials we authenticate against. */
  organizationId: string;
  /**
   * Vendor the scan should prefer when both credentials are available.
   * Set this to the calling orchestrator agent's vendor so a Codex-vendor
   * orchestrator gets a Codex scan (the orchestrator's model and the scan
   * runtime stay in lockstep — no surprise cross-vendor calls that fail
   * with a credential the calling agent isn't billed against).
   *
   * - `"openai"` → Codex first, Anthropic only as fallback.
   * - `"anthropic"` (or omitted) → Anthropic first, Codex as fallback.
   *
   * Either path falls back to the OTHER vendor if the preferred vendor
   * isn't credentialed. This option only changes which vendor wins when
   * both have a usable credential.
   */
  preferredVendor?: "anthropic" | "openai";
}

/**
 * Resolves the per-org credential for one vendor + executes the scan via
 * the matching SDK helper. Returns the result text on success, throws
 * with a precise reason on every failure mode (no credential, SDK
 * error, empty response).
 */
export async function runArchitectureScan(
  opts: RunArchitectureScanOptions,
): Promise<string> {
  // Sanity-check the org exists before doing the credential dance.
  const org = await Organization.findByPk(opts.organizationId, {
    attributes: ["id"],
  });
  if (!org) {
    throw new Error(
      `Cannot run architecture scan: organization "${opts.organizationId}" not found.`,
    );
  }

  const codexFirst = opts.preferredVendor === "openai";

  // Vendor-pinned ordering. The "preferred" vendor is tried first; if its
  // credential is missing, fall back to the other. This is what keeps a
  // Codex orchestrator from accidentally invoking the Anthropic SDK just
  // because the org has an Anthropic key on file.
  const tryAnthropic = async (): Promise<string | null> => {
    const anthropicCred = await resolveAnthropicCredentialForOrg(opts.organizationId);
    if (!anthropicCred) return null;
    logger.info("runArchitectureScan: using Anthropic SDK", {
      cwd: opts.cwd,
      organizationId: opts.organizationId,
      keyType: anthropicCred.keyType,
      preferredVendor: opts.preferredVendor ?? "(default)",
    });
    const result = await runAnthropicScanCwd({
      credential: anthropicCred.credential,
      keyType: anthropicCred.keyType,
      model: ANTHROPIC_SCAN_MODEL,
      systemPrompt: SCAN_SYSTEM_PROMPT,
      userPrompt: opts.prompt,
      cwd: opts.cwd,
    });
    const text = (result.finalText ?? "").trim();
    if (!text) {
      throw new Error(
        "Anthropic scan returned an empty response — model halted without producing output.",
      );
    }
    return text;
  };

  const tryCodex = async (): Promise<string | null> => {
    const codexCred = await resolveCodexCredentialForOrg(opts.organizationId);
    if (!codexCred) return null;
    logger.info("runArchitectureScan: using Codex SDK", {
      cwd: opts.cwd,
      organizationId: opts.organizationId,
      authPath: codexCred.authObject ? "auth_object" : "api_key",
      preferredVendor: opts.preferredVendor ?? "(default)",
    });
    const result = await runCodexScanCwd({
      apiKey: codexCred.apiKey,
      authObject: codexCred.authObject,
      model: CODEX_SCAN_MODEL,
      systemPrompt: SCAN_SYSTEM_PROMPT,
      userPrompt: opts.prompt,
      cwd: opts.cwd,
    });
    const text = (result.finalText ?? "").trim();
    if (!text) {
      throw new Error(
        "Codex scan returned an empty response — model halted without producing output.",
      );
    }
    return text;
  };

  const [primary, fallback] = codexFirst
    ? [tryCodex, tryAnthropic]
    : [tryAnthropic, tryCodex];

  const primaryResult = await primary();
  if (primaryResult !== null) return primaryResult;
  const fallbackResult = await fallback();
  if (fallbackResult !== null) return fallbackResult;

  throw new Error(
    `Cannot run architecture scan: organization "${opts.organizationId}" has no ` +
      `Anthropic or OpenAI credential configured. Upload one in Admin → ` +
      `Vendor API Keys before generating an architecture overview.`,
  );
}

const SCAN_SYSTEM_PROMPT =
  "You are a code architect with read-only access to a repository on disk. " +
  "Use your file-reading tools (Read / Glob / Grep) to enumerate the folder " +
  "structure and inspect key configuration files. Produce a comprehensive " +
  "folder-level architecture document. Do not modify any files.";

interface AnthropicCred {
  credential: string;
  keyType: "api_key" | "oauth_token";
}

interface CodexCred {
  apiKey: string | null;
  authObject: Record<string, unknown> | null;
}

/**
 * Finds the org's Anthropic credential. Mirrors `resolveOrgVendor`'s
 * priority rule: oauth_token wins over api_key (Pro/Max subscription
 * billing) for the same org. Returns null when no usable row exists.
 */
async function resolveAnthropicCredentialForOrg(
  organizationId: string,
): Promise<AnthropicCred | null> {
  // Look up the Anthropic vendor row by chasing through the model
  // catalog, so we don't hard-code a vendor slug at this layer.
  const model = await LLMModel.findOne({
    where: { slug: ANTHROPIC_SCAN_MODEL },
    attributes: ["vendorId"],
  });
  if (!model) return null;
  const vendor = await Vendor.findByPk(model.vendorId, {
    attributes: ["id", "slug"],
  });
  if (!vendor || vendor.slug !== "anthropic") return null;

  const rows = await OrganizationVendorApiKey.findAll({
    where: { organizationId, vendorId: vendor.id },
    attributes: ["apiKey", "keyType"],
  });
  const oauth = rows.find(
    (r) =>
      r.keyType === "oauth_token" &&
      typeof r.apiKey === "string" &&
      r.apiKey.length > 0,
  );
  const apiKey = rows.find(
    (r) =>
      r.keyType === "api_key" &&
      typeof r.apiKey === "string" &&
      r.apiKey.length > 0,
  );
  const picked = oauth ?? apiKey;
  if (!picked || !picked.apiKey) return null;
  return {
    credential: picked.apiKey,
    keyType: picked.keyType === "oauth_token" ? "oauth_token" : "api_key",
  };
}

/**
 * Finds the org's OpenAI credential — auth_object preferred (ChatGPT-account
 * login), api_key fallback. Returns null when no usable row exists.
 */
async function resolveCodexCredentialForOrg(
  organizationId: string,
): Promise<CodexCred | null> {
  const model = await LLMModel.findOne({
    where: { slug: CODEX_SCAN_MODEL },
    attributes: ["vendorId"],
  });
  if (!model) return null;
  const vendor = await Vendor.findByPk(model.vendorId, {
    attributes: ["id", "slug"],
  });
  if (!vendor || vendor.slug !== "openai") return null;

  const rows = await OrganizationVendorApiKey.findAll({
    where: { organizationId, vendorId: vendor.id },
    attributes: ["apiKey", "authObject", "keyType"],
  });
  const authObjectRow = rows.find(
    (r) =>
      r.keyType === "auth_object" &&
      r.authObject !== null &&
      typeof r.authObject === "object",
  );
  const apiKeyRow = rows.find(
    (r) =>
      r.keyType === "api_key" &&
      typeof r.apiKey === "string" &&
      r.apiKey.length > 0,
  );
  if (!authObjectRow && !apiKeyRow) return null;
  return {
    apiKey: apiKeyRow?.apiKey ?? null,
    authObject: authObjectRow?.authObject ?? null,
  };
}
