/**
 * Slice 14 rewrite — DB-backed Codex auth.json materialisation.
 *
 * What this module does
 * ---------------------
 * Looks up the per-org Codex auth.json blob (stored as a `key_type =
 * 'auth_object'` row on `organization_vendor_api_keys` for the OpenAI
 * vendor) and materialises it as a `~/.codex/auth.json` file. Normal
 * Codex chat turns use a persistent per-org $HOME under the agent Codex
 * volume so resume metadata survives across turns; stateless helpers can
 * still use a per-turn temp $HOME.
 *
 * Why this design
 * ---------------
 *  - Codex CLI reads `$HOME/.codex/auth.json` directly on every spawn
 *    — there's no env-var equivalent for the structured ChatGPT-account
 *    login.
 *  - Multi-tenant safety: different orgs MUST NOT race on a single
 *    `~/.codex/auth.json` file. Per-org homes isolate chat turns while
 *    still preserving Codex resume state.
 *  - System-wide bootstrap (the prior `/home/agent/.codex/auth.json`
 *    on a non-existent volume mount) is gone — slice 14 explicitly
 *    killed it. Each org sets its own credential via the regular
 *    vendor-api-keys admin UI.
 *
 * The caller is responsible for invoking `cleanup()`. For persistent
 * per-org homes it is intentionally a no-op.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Op } from "sequelize";
import {
  Agent,
  OrganizationVendorApiKey,
  Vendor,
} from "@scheduling-agent/database";

import { logger } from "../logger";

const OPENAI_VENDOR_SLUG = "openai";
const AGENT_HOME = process.env.AGENT_HOME ?? "/home/agent";
const CODEX_ORG_HOME_ROOT = path.join(AGENT_HOME, ".codex", "orgs");

function safeOrgPathSegment(organizationId: string): string {
  const trimmed = organizationId.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new Error(
      `Invalid organization id for Codex home path: ${organizationId}`,
    );
  }
  return trimmed;
}

/**
 * Looks up the Codex auth.json blob configured for the given
 * organization. Returns null when the org has no `auth_object` row for
 * the OpenAI vendor — the runner should fall back to plain
 * `api_key`-based auth in that case.
 */
export async function loadCodexAuthObjectForOrg(
  organizationId: string | null | undefined,
): Promise<Record<string, unknown> | null> {
  if (!organizationId) return null;
  try {
    const vendor = await Vendor.findOne({
      where: { slug: OPENAI_VENDOR_SLUG },
      attributes: ["id"],
    });
    if (!vendor) return null;
    const row = await OrganizationVendorApiKey.findOne({
      where: {
        organizationId,
        vendorId: vendor.id,
        keyType: "auth_object",
      },
      attributes: ["authObject"],
    });
    return row?.authObject ?? null;
  } catch (err) {
    logger.warn("loadCodexAuthObjectForOrg failed", {
      organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Convenience: resolve the agent's organization id, then look up its
 * Codex auth_object. Returns null when the agent is missing or the org has
 * no auth_object row.
 */
export async function loadCodexAuthObjectForAgent(
  agentId: string | null | undefined,
): Promise<Record<string, unknown> | null> {
  const resolved = await loadCodexAuthObjectForAgentWithOrg(agentId);
  return resolved?.authObject ?? null;
}

export interface CodexAuthObjectForAgent {
  organizationId: string | null;
  authObject: Record<string, unknown> | null;
}

/**
 * Same lookup as `loadCodexAuthObjectForAgent`, but preserves the org id so
 * callers can materialise the auth blob under a persistent per-org Codex home.
 */
export async function loadCodexAuthObjectForAgentWithOrg(
  agentId: string | null | undefined,
): Promise<CodexAuthObjectForAgent | null> {
  if (!agentId) return null;
  try {
    const agent = await Agent.findByPk(agentId, {
      attributes: ["organizationId"],
    });
    const organizationId = agent?.organizationId ?? null;
    return {
      organizationId,
      authObject: await loadCodexAuthObjectForOrg(organizationId),
    };
  } catch (err) {
    logger.warn("loadCodexAuthObjectForAgentWithOrg failed", {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface MaterialisedCodexHome {
  /** Absolute path to the $HOME directory. Set HOME=this when
   *  spawning Codex CLI so it reads `<this>/.codex/auth.json`. */
  homeDir: string;
  /** Cleanup callback. Idempotent; no-op for persistent per-org homes. */
  cleanup: () => Promise<void>;
}

export interface MaterialiseCodexHomeOptions {
  /**
   * When supplied, use a persistent per-org home under the agent Codex
   * volume instead of a per-turn /tmp directory. This lets Codex resume
   * threads because its local rollout/session cache survives across turns.
   */
  organizationId?: string | null;
}

/**
 * Writes the supplied `auth.json` blob to a Codex-compatible $HOME and
 * returns the path + a cleanup callback. By default this uses a fresh temp
 * $HOME. When `organizationId` is supplied, it uses a persistent per-org
 * home under `/home/agent/.codex/orgs/<org_id>`, which keeps Codex's local
 * rollout/session cache available for `resumeThread()`.
 *
 * The directory layout matches what Codex CLI expects:
 *
 *   <homeDir>/
 *     .codex/
 *       auth.json   (mode 0o600)
 *
 * Without `organizationId`, each call creates a NEW temp dir via `mkdtemp`
 * and `cleanup()` removes it after the turn. With `organizationId`, the
 * directory is reused and `cleanup()` is intentionally a no-op.
 */
export async function materialiseCodexHome(
  blob: Record<string, unknown>,
  options: MaterialiseCodexHomeOptions = {},
): Promise<MaterialisedCodexHome> {
  const homeDir = options.organizationId
    ? path.join(CODEX_ORG_HOME_ROOT, safeOrgPathSegment(options.organizationId))
    : await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  await fs.promises.mkdir(codexDir, { recursive: true, mode: 0o700 });
  const authFile = path.join(codexDir, "auth.json");
  await fs.promises.writeFile(authFile, JSON.stringify(blob, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  // Best-effort chmod in case the writeFile mode was ignored on a
  // filesystem that doesn't honour it.
  try {
    await fs.promises.chmod(authFile, 0o600);
  } catch {
    /* ignore */
  }

  let cleanedUp = false;
  const cleanup = async () => {
    if (options.organizationId) return;
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      await fs.promises.rm(homeDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn("materialiseCodexHome: cleanup failed (non-fatal)", {
        homeDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return { homeDir, cleanup };
}

// Type re-export to satisfy callers (e.g. existing tests / admin UIs)
// that still import the legacy status shape. Used only for typing.
export interface CodexAuthJsonStatus {
  configured: boolean;
  accountIdSuffix: string | null;
  accessTokenMasked: string | null;
  hasRefreshToken: boolean;
  hasOpenaiApiKey: boolean;
  lastRefresh: string | null;
  updatedAt: string | null;
}

void Op;
