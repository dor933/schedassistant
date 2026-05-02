/**
 * In-process registry of per-turn `StructuredToolInterface[]` instances
 * for the Codex / mcp_server bridge.
 *
 * Why this exists
 * ---------------
 * The tool factories used by every callModel node (basicGraph, epicGraph,
 * roundtableGraph, applicationGraph) close over per-request state: the
 * caller agent id, user id, thread id, group / single-chat id, the live
 * Sequelize connection pool, and (for the epic graph) the
 * `drainSessionFileLedger` callback. None of that survives a JSON
 * serialization across the `mcp_server` boundary.
 *
 * The runner solves it by holding the live tool instances in this
 * module-level registry, keyed by a freshly-minted `registryId` carried
 * inside the per-turn JWT. When `mcp_server` calls back into
 * `/internal/tools/call`, the JWT's `registryId` selects the registry
 * entry, and the tool is invoked in-process with all its closures
 * intact.
 *
 * Lifecycle
 * ---------
 * - `register(...)` is called once at the start of a turn. It returns
 *   nothing — the caller has already minted a `registryId` (via
 *   `newRegistryId()` in `codexBridgeAuth`) and supplies it. This split
 *   lets the JWT and the registry entry be created atomically by the
 *   runner without two round-trips through this module.
 * - `release(...)` is called from a `finally` block when the turn ends
 *   (success, error, or timeout). It removes the entry immediately.
 * - A periodic sweep evicts entries past their `expiresAt` — backstop
 *   for the case where the runner crashes / is killed mid-turn and
 *   never reaches its `release(...)`. Without the sweep we'd leak a
 *   tool list (and its closures) per crash.
 *
 * Concurrency
 * -----------
 * The Map is single-threaded (Node) so no locking. Multiple turns
 * register at once with disjoint `registryId`s. Tool invocations from
 * the bridge race only against `release(...)` of their own entry —
 * a release-during-invoke is the runner shutting the turn down, in
 * which case the tool's caller will get a "registry not found" 404
 * which mcp_server surfaces as an MCP error to the CLI. The CLI's
 * built-in retry / error path handles it cleanly.
 */

import type { StructuredToolInterface } from "@langchain/core/tools";

/**
 * Optional callback invoked after every successful tool execution with
 * the (possibly-sanitized) tool result text. Identical contract to
 * `ToolResultObserver` in `agentSdkAdapter.ts:131` so the epic graph's
 * EPIC_CONTINUATION marker detection can be reused unchanged.
 *
 * The observer is invoked in-process inside `/internal/tools/call`,
 * before the response is sent back over the wire. Failures inside the
 * observer must NEVER break a tool result — the controller wraps the
 * call in a try/catch and logs.
 */
export type ToolResultObserver = (result: {
  toolName: string;
  text: string;
  argsSummary: string;
}) => void;

interface RegistryEntry {
  /** Live tool instances with their closures intact. */
  tools: StructuredToolInterface[];
  /** Optional observer; nullable so non-epic callers don't pay the cost. */
  observer: ToolResultObserver | null;
  /**
   * Coarse-grained per-entry context, mirrored from the JWT for
   * defense-in-depth. The controller cross-checks the JWT's claims
   * against this — a registryId smuggled across requests with mismatched
   * claims is an error, not a feature.
   */
  context: {
    agentId: string | null;
    userId: number | null;
    threadId: string | null;
    source: string;
  };
  /** ms since epoch — entry is evictable after this. */
  expiresAt: number;
}

const registry = new Map<string, RegistryEntry>();

/**
 * Default per-entry TTL. Overridable per `register()` call when a
 * specific runner has a longer / shorter SLA in mind. The JWT's `exp`
 * is the authoritative deadline for tool invocation — this TTL is just
 * the in-memory backstop in case the runner never calls `release()`.
 */
const DEFAULT_TTL_MS = 35 * 60 * 1000; // a hair longer than the JWT default (30m)

/**
 * Sweep interval. 60 seconds is plenty — entries are typically released
 * by their runner within seconds of turn completion, and the worst case
 * for a leaked entry is the TTL above plus 60s.
 */
const SWEEP_INTERVAL_MS = 60 * 1000;

let sweeperHandle: NodeJS.Timeout | null = null;

function ensureSweeperRunning(): void {
  if (sweeperHandle) return;
  sweeperHandle = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of registry) {
      if (entry.expiresAt <= now) registry.delete(id);
    }
  }, SWEEP_INTERVAL_MS);
  // Don't pin the event loop alive if the rest of the process exits.
  sweeperHandle.unref?.();
}

export interface RegisterOptions {
  registryId: string;
  tools: StructuredToolInterface[];
  observer?: ToolResultObserver | null;
  context: RegistryEntry["context"];
  ttlMs?: number;
}

/** Registers a fresh entry. Idempotent on `registryId` (last write wins). */
export function register(opts: RegisterOptions): void {
  ensureSweeperRunning();
  registry.set(opts.registryId, {
    tools: opts.tools,
    observer: opts.observer ?? null,
    context: opts.context,
    expiresAt: Date.now() + (opts.ttlMs ?? DEFAULT_TTL_MS),
  });
}

/** Removes an entry. Safe to call multiple times. */
export function release(registryId: string): void {
  registry.delete(registryId);
}

/**
 * Looks up an entry. Returns `null` when the entry is missing OR has
 * expired (the sweeper may not have caught it yet — check on read too).
 */
export function lookup(registryId: string): RegistryEntry | null {
  const entry = registry.get(registryId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    registry.delete(registryId);
    return null;
  }
  return entry;
}

/** Test-only helper for clearing the registry between tests. */
export function _resetForTests(): void {
  registry.clear();
}
