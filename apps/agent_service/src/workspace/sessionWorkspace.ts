import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import type { SessionFileEntry } from "@scheduling-agent/types";

/**
 * Per-thread session workspace — a folder under each agent's existing
 * `workspacePath` that holds files written during a single conversation
 * thread. Layout:
 *
 *     <agent.workspacePath>/threads/<threadId>/
 *
 * The folder is created lazily by the context builder when the thread first
 * runs through a graph. Files written there by FS-MCP tools are recorded into
 * a per-thread in-memory ledger via `recordSessionFileWrite`, then drained
 * into LangGraph state by `drainSessionFileLedger` after each tool round.
 *
 * Why a ledger and not a direct state mutation? LangChain `tool()` returns a
 * string — there is no clean way for a tool to push a structured patch into
 * the surrounding LangGraph state. Capturing writes in a module-level Map
 * keyed by `threadId` keeps the side-effect local to the originating turn
 * (no cross-thread leak — `threadId` is unique) without monkey-patching the
 * LangGraph runtime.
 */

/** Folder name used under `agent.workspacePath` to hold per-thread folders. */
const THREADS_DIR = "threads";

/**
 * Resolves the absolute per-thread workspace path for an agent + thread, or
 * `null` when the agent has no workspace configured (system agents, agents
 * without filesystem MCP, etc.). Pure — does not touch the filesystem.
 */
export function resolveSessionWorkspacePath(
  agentWorkspacePath: string | null | undefined,
  threadId: string | null | undefined,
): string | null {
  if (!agentWorkspacePath || !threadId) return null;
  const trimmedThread = threadId.trim();
  if (!trimmedThread) return null;
  return path.join(agentWorkspacePath, THREADS_DIR, trimmedThread);
}

/**
 * Ensures the per-thread folder exists. Idempotent. No-op when `path` is null
 * (e.g. the agent has no workspace). Errors are swallowed and logged by the
 * caller — folder creation should never fail a turn.
 */
export async function ensureSessionWorkspace(
  sessionWorkspacePath: string | null,
): Promise<void> {
  if (!sessionWorkspacePath) return;
  await mkdir(sessionWorkspacePath, { recursive: true });
}

/**
 * Resolves a path provided by an LLM/tool (relative or absolute) against a
 * known session workspace root, rejecting anything that escapes the root.
 * Throws on traversal (`..`), absolute paths outside the root, or any path
 * whose normalised form leaves the root.
 *
 * Returns the absolute, normalised path on success.
 */
export function resolveSessionFilePath(
  sessionWorkspacePath: string,
  candidate: string,
): string {
  const root = path.resolve(sessionWorkspacePath);
  const joined = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(root, candidate);
  const rel = path.relative(root, joined);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Path "${candidate}" resolves outside the session workspace`,
    );
  }
  return joined;
}

/**
 * Reducer for `AgentAnnotation.sessionFiles`. Merges the incoming entries
 * onto the existing list, keyed by `path`. Last-write-wins per path so
 * `bytes` / `updatedAt` reflect the most recent write.
 */
export function mergeSessionFilesByPath(
  prev: SessionFileEntry[],
  incoming: SessionFileEntry[],
): SessionFileEntry[] {
  if (!incoming || incoming.length === 0) return prev;
  const byPath = new Map<string, SessionFileEntry>();
  for (const e of prev) byPath.set(e.path, e);
  for (const e of incoming) {
    const existing = byPath.get(e.path);
    byPath.set(e.path, existing ? { ...existing, ...e } : e);
  }
  return [...byPath.values()];
}

// ─── Per-thread write ledger ───────────────────────────────────────────────

/**
 * Module-level map keyed by threadId. The wrapper around FS-MCP write tools
 * pushes into here; `drainSessionFileLedger` is called from the call-model
 * node after each tool round to fold pending writes back into state.
 *
 * Keyed by `threadId` (UUID), so concurrent threads cannot leak entries
 * into each other.
 */
const ledger = new Map<string, SessionFileEntry[]>();

/**
 * Records a successful FS write into the per-thread ledger. The wrapper
 * computes `bytes` (best effort — `stat` after write) and `updatedAt`.
 */
export function recordSessionFileWrite(
  threadId: string,
  entry: SessionFileEntry,
): void {
  if (!threadId) return;
  const arr = ledger.get(threadId) ?? [];
  const idx = arr.findIndex((e) => e.path === entry.path);
  if (idx >= 0) {
    arr[idx] = { ...arr[idx], ...entry };
  } else {
    arr.push(entry);
  }
  ledger.set(threadId, arr);
}

/**
 * Returns and clears all pending writes for `threadId`. Called from the
 * call-model node after each tool round so writes are folded into state.
 */
export function drainSessionFileLedger(threadId: string): SessionFileEntry[] {
  if (!threadId) return [];
  const arr = ledger.get(threadId);
  if (!arr || arr.length === 0) return [];
  ledger.delete(threadId);
  return arr;
}

/**
 * Best-effort byte count for a path that was just written. Returns 0 on any
 * error so a stat failure never blocks the surrounding tool call.
 */
export async function statBytes(absPath: string): Promise<number> {
  try {
    const s = await stat(absPath);
    return s.size;
  } catch {
    return 0;
  }
}

// ─── Write-extension allow-list ───────────────────────────────────────────

/**
 * Extensions an agent is allowed to write to disk. Restricting writes to
 * plain-text formats keeps the artifact pipeline simple — files in these
 * formats can be sent to and received from users without format-specific
 * conversion logic. Any other extension (.json, .csv, .pdf, .xlsx, etc.)
 * is rejected at the tool layer; if a downstream consumer needs another
 * format, the conversion happens at send time, not at write time.
 *
 * Comparisons are case-insensitive.
 */
export const ALLOWED_WRITE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".txt",
]);

/**
 * Returns true when the given path ends in an allowed write extension.
 * Files with no extension or with disallowed extensions return false.
 */
export function isWriteAllowedExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ALLOWED_WRITE_EXTENSIONS.has(ext);
}

/**
 * Friendly rejection message returned to the LLM when it tries to write a
 * disallowed extension. Names the extension it tried so the model can
 * correct itself, and explains the policy briefly so it doesn't retry the
 * same way.
 */
export function rejectExtensionMessage(filePath: string): string {
  const ext = path.extname(filePath) || "(no extension)";
  const allowed = [...ALLOWED_WRITE_EXTENSIONS].join(", ");
  return (
    `Refused to write "${filePath}": only ${allowed} files may be written ` +
    `(got "${ext}"). Save the content as a .md or .txt file instead — the ` +
    `system handles format conversion later when delivering files to users.`
  );
}
