/**
 * Read-only repo-scan wrapper around `runCodexInRepo` (slice 21 +
 * generalised in slice 23). Pinned to `sandboxMode: "read-only"` so the
 * model can browse + reason but cannot apply patches or run shell.
 *
 * Kept as a named helper (rather than inlining `runCodexInRepo` at every
 * scan call site) because "scan a repo" is a recognisable concept in
 * its own right — `runArchitectureScan` and any future scanner read
 * better with this name than with raw `sandboxMode` plumbing in their
 * faces.
 */

import { runCodexInRepo, type CodexSandboxMode } from "./codexInRepo";

export interface CodexScanCwdOptions {
  /** Per-org OpenAI API key. Optional — supply `authObject` instead for
   *  the ChatGPT-account login path (slice 14). */
  apiKey?: string | null;
  /** Per-org Codex CLI auth.json blob. Mutually exclusive with
   *  `apiKey` in practice. */
  authObject?: Record<string, unknown> | null;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
}

export interface CodexScanCwdResult {
  finalText: string;
}

const READ_ONLY: CodexSandboxMode = "read-only";

export async function runCodexScanCwd(
  opts: CodexScanCwdOptions,
): Promise<CodexScanCwdResult> {
  const result = await runCodexInRepo({
    apiKey: opts.apiKey ?? null,
    authObject: opts.authObject ?? null,
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    cwd: opts.cwd,
    sandboxMode: READ_ONLY,
    observeName: "codex_scan_cwd",
  });
  return { finalText: result.finalText };
}
