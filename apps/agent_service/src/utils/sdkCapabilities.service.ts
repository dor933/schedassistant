/**
 * Single read-side helper for SDK capabilities (filesystem / bash).
 *
 * The boolean columns `agents.allow_sdk_builtins` and `agents.allow_sdk_bash`
 * were dropped in migration 145. Capability is now stored on the
 * `agent_sdk_capabilities` junction table, joined to `sdk_capabilities`.
 * Every runtime call-site that previously read those booleans goes through
 * this helper so the join + slug lookup live in one place.
 *
 * Caching: deliberately none. Capability rows are admin-mutable from the UI
 * and runtime reads are infrequent (once per call to start a query / build a
 * sub-agent bundle). A request-scoped cache could be added later if profiling
 * shows it; today the extra ~1ms per agent is not worth the cache-invalidation
 * surface.
 */

import { Op } from "sequelize";
import {
  AgentSdkCapability,
  SdkCapability,
} from "@scheduling-agent/database";
import { logger } from "../logger";

export interface AgentSdkCapabilities {
  /** True iff the agent has the `filesystem` SDK capability attached AND active.
   *  Replaces every read of the legacy `allow_sdk_builtins` boolean. */
  hasFilesystem: boolean;
  /** True iff the agent has the `bash` SDK capability attached AND active.
   *  Replaces every read of the legacy `allow_sdk_bash` boolean. */
  hasBash: boolean;
}

/**
 * Returns which SDK capabilities are bound to the given agent. Both fields
 * default to `false` on lookup failure (e.g. transient DB error) — same
 * conservative "deny by default" the legacy code applied when the agent
 * row failed to load.
 */
export async function getAgentSdkCapabilities(
  agentId: string | null | undefined,
): Promise<AgentSdkCapabilities> {
  if (!agentId) return { hasFilesystem: false, hasBash: false };

  try {
    const rows = await AgentSdkCapability.findAll({
      where: { agentId, active: true },
      attributes: ["sdkCapabilityId"],
    });
    if (rows.length === 0) return { hasFilesystem: false, hasBash: false };

    const ids = rows.map((r) => r.sdkCapabilityId);
    const caps = await SdkCapability.findAll({
      where: { id: { [Op.in]: ids } },
      attributes: ["slug"],
    });
    const slugs = new Set(caps.map((c) => c.slug));
    return {
      hasFilesystem: slugs.has("filesystem"),
      hasBash: slugs.has("bash"),
    };
  } catch (err) {
    logger.warn("getAgentSdkCapabilities: lookup failed — defaulting to all-off", {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { hasFilesystem: false, hasBash: false };
  }
}
