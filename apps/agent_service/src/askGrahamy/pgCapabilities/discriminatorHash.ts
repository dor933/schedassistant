import { createHash } from "node:crypto";

/**
 * Deterministic hash of arbitrary capability cache params. Used by
 * capabilities with multi-field or free-form discriminators
 * (feature_screen, factor_conditioned_backtest, sector_delta) where a
 * single `rankingBasis` string isn't enough. Sorted-canonical-JSON +
 * md5 hex keeps it stable across runtime versions and pure (no salt).
 *
 * Lives in its own module so capability files can import it without
 * pulling in `./registry` (which imports each capability's
 * `*Discriminators` function — circular).
 */
export function hashCapabilityParams(
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const ordered: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    ordered[key] = value === undefined ? null : value;
  }
  return createHash("md5").update(JSON.stringify(ordered)).digest("hex");
}
