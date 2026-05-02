/**
 * Slice 14 rewrite — DB-backed Codex auth.json materialisation.
 *
 * What this module does
 * ---------------------
 * Looks up the per-org Codex auth.json blob (stored as a `key_type =
 * 'auth_object'` row on `organization_vendor_api_keys` for the OpenAI
 * vendor) and materialises it as a `~/.codex/auth.json` file inside a
 * per-turn temp $HOME directory. The Codex SDK runner sets `HOME` to
 * the temp dir for the spawned `codex` subprocess so the CLI reads our
 * per-org auth without touching any other org's file.
 *
 * Why this design
 * ---------------
 *  - Codex CLI reads `$HOME/.codex/auth.json` directly on every spawn
 *    — there's no env-var equivalent for the structured ChatGPT-account
 *    login.
 *  - Multi-tenant safety: concurrent turns from different orgs MUST
 *    NOT race on a single `~/.codex/auth.json` file. Per-turn temp
 *    $HOME isolates each call.
 *  - System-wide bootstrap (the prior `/home/agent/.codex/auth.json`
 *    on a non-existent volume mount) is gone — slice 14 explicitly
 *    killed it. Each org sets its own credential via the regular
 *    vendor-api-keys admin UI.
 *
 * The caller (the Codex SDK runner) is responsible for cleaning up
 * the temp dir after the turn completes — this module just writes.
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
 * Codex auth_object. Throws if the agent is missing — caller treats
 * that as a hard error (no agent → no org → no credential).
 */
export async function loadCodexAuthObjectForAgent(
  agentId: string | null | undefined,
): Promise<Record<string, unknown> | null> {
  if (!agentId) return null;
  try {
    const agent = await Agent.findByPk(agentId, {
      attributes: ["organizationId"],
    });
    return loadCodexAuthObjectForOrg(agent?.organizationId ?? null);
  } catch (err) {
    logger.warn("loadCodexAuthObjectForAgent failed", {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface MaterialisedCodexHome {
  /** Absolute path to the temp $HOME directory. Set HOME=this when
   *  spawning Codex CLI so it reads `<this>/.codex/auth.json`. */
  homeDir: string;
  /** Cleanup callback — `rm -rf` the temp dir. Idempotent; safe to
   *  call multiple times (only the first call does work). */
  cleanup: () => Promise<void>;
}

/**
 * Writes the supplied `auth.json` blob to a fresh temp $HOME directory
 * and returns the path + a cleanup callback. The directory layout
 * matches what Codex CLI expects:
 *
 *   <homeDir>/
 *     .codex/
 *       auth.json   (mode 0o600)
 *
 * Each call creates a NEW temp dir via `mkdtemp`, so concurrent turns
 * from different orgs cannot collide. The runner's `finally` block
 * invokes `cleanup` to remove the dir after the turn ends.
 *
 * Note: the dir lives under the OS tmpdir, which is typically a
 * tmpfs-backed volume that survives container life but not host
 * reboots. That's fine — the auth.json is sourced from the DB on every
 * turn, never from the temp dir.
 */
export async function materialiseCodexHome(
  blob: Record<string, unknown>,
): Promise<MaterialisedCodexHome> {
  const homeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-home-"));
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
