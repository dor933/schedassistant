/**
 * General-purpose Codex SDK invocation pinned to a working directory,
 * with the sandbox mode configurable per call (slice 23).
 *
 * Two distinct use cases drive this helper:
 *   1. Read-only repo scans — architecture overview, plan generation.
 *      `sandboxMode: "read-only"` lets the codex CLI use its built-in
 *      file-reading tools but blocks every write/exec at the sandbox
 *      layer. The legacy `codexScanCwd` helper is now a thin wrapper
 *      around this with the mode pinned.
 *   2. Repo-modifying epic-task execution — slice 23's
 *      `start_epic_task_codex`. `sandboxMode: "workspace-write"` lets
 *      codex apply patches + run shell commands inside the repo cwd
 *      (still no network, still no host-wide write).
 *
 * Why generalised vs. duplicating two near-identical helpers:
 *   - Credential resolution (apiKey / authObject), env scrubbing, codex
 *     home materialisation, langfuse tracing — all identical between
 *     read-only and workspace-write paths. Splitting the file just
 *     means dragging two copies along whenever a vendor-side detail
 *     changes (auth.json fix, env var rename, etc.). One helper.
 *
 * The codex CLI has no native `systemPrompt` parameter — same constraint
 * the existing one-shot/scan helpers handle by prepending a
 * `# System\n…\n\n# Task\n…` envelope to the user prompt. Same
 * convention here.
 */

import type { CodexOptions, ThreadOptions } from "@openai/codex-sdk";

import { loadCodexSdk } from "./codexSdkLoader";
import { observeWithContext, recordSdkGeneration } from "../../langfuse";
import { materialiseCodexHome } from "../../utils/codexAuthJson.service";

const AGENT_HOME = "/home/agent";

export type CodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export interface CodexInRepoOptions {
  /** Per-org OpenAI API key. Optional — supply `authObject` instead for
   *  the ChatGPT-account login path. */
  apiKey?: string | null;
  /** Per-org Codex CLI auth.json blob (ChatGPT-account login). Mutually
   *  exclusive with `apiKey` in practice. */
  authObject?: Record<string, unknown> | null;
  /** Codex model slug (e.g. `gpt-5`, `gpt-4o`, `o4-mini`). */
  model: string;
  /** System-side instructions — prepended to the user prompt as
   *  `# System\n…\n\n# Task\n…` because Codex has no native systemPrompt. */
  systemPrompt: string;
  /** User-side prompt — the actual task / scan / plan request. */
  userPrompt: string;
  /** Absolute path the codex CLI runs in. Read/Write/Glob/Grep/etc.
   *  resolve relative to this — required for any repo-aware behaviour. */
  cwd: string;
  /**
   * Sandbox mode passed to `ThreadOptions.sandboxMode`. Drives whether
   * codex can write/edit files and run shell commands inside `cwd`:
   *   - `"read-only"`        — scan + reason only. No writes, no exec.
   *   - `"workspace-write"`  — full agentic execution within `cwd`.
   *   - `"danger-full-access"` — same as workspace-write plus host-wide
   *                              access; reserved for the few one-shot
   *                              callers that legitimately need it.
   */
  sandboxMode: CodexSandboxMode;
  /** Tag carried into the langfuse span name. Helps tell apart
   *  "scan" vs "plan" vs "execute" call sites in trace dashboards. */
  observeName?: string;
}

export interface CodexInRepoResult {
  finalText: string;
}

function buildEnv(args: {
  apiKey: string | null;
  homeDir: string | null;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  if (args.apiKey) {
    env.OPENAI_API_KEY = args.apiKey;
    env.CODEX_API_KEY = args.apiKey;
  }
  env.HOME = args.homeDir ?? AGENT_HOME;
  if (process.env.MERIDIAN_URL) {
    env.OPENAI_BASE_URL = process.env.MERIDIAN_URL;
  }
  return env;
}

export async function runCodexInRepo(
  opts: CodexInRepoOptions,
): Promise<CodexInRepoResult> {
  if (!opts.apiKey && !opts.authObject) {
    throw new Error(
      "runCodexInRepo: caller must supply either `apiKey` or `authObject`.",
    );
  }
  const useAuthObject = !!opts.authObject;
  const effectiveApiKey = useAuthObject ? null : (opts.apiKey ?? null);

  return observeWithContext(
    opts.observeName ?? "codex_in_repo",
    async () => {
      const sdk = await loadCodexSdk();

      const materialised = useAuthObject
        ? await materialiseCodexHome(opts.authObject as Record<string, unknown>)
        : null;
      try {
        const codexOptions: CodexOptions = {
          ...(effectiveApiKey ? { apiKey: effectiveApiKey } : {}),
          env: buildEnv({
            apiKey: effectiveApiKey,
            homeDir: materialised ? materialised.homeDir : null,
          }),
        };

        const threadOptions: ThreadOptions = {
          model: opts.model,
          workingDirectory: opts.cwd,
          skipGitRepoCheck: true,
          sandboxMode: opts.sandboxMode,
          approvalPolicy: "never",
        };

        const codex = new sdk.Codex(codexOptions);
        const thread = codex.startThread(threadOptions);

        const prompt = `# System\n${opts.systemPrompt}\n\n# Task\n${opts.userPrompt}`;
        const turn = await thread.run(prompt);

        recordSdkGeneration({
          name: `${opts.observeName ?? "codex_in_repo"}_generation`,
          model: opts.model,
          input: {
            messages: [
              { role: "system", content: opts.systemPrompt },
              { role: "user", content: opts.userPrompt },
            ],
          },
          output: turn.finalResponse,
          ...(turn.usage
            ? {
                usage: Object.fromEntries(
                  Object.entries(turn.usage).filter(
                    (entry): entry is [string, number] =>
                      typeof entry[1] === "number" && Number.isFinite(entry[1]),
                  ),
                ),
              }
            : {}),
          metadata: {
            vendor: "openai",
            cwd: opts.cwd,
            sandboxMode: opts.sandboxMode,
            authPath: useAuthObject ? "auth_object" : "api_key",
          },
        });

        return { finalText: turn.finalResponse };
      } finally {
        if (materialised) {
          try {
            await materialised.cleanup();
          } catch {
            /* logged inside materialiseCodexHome's cleanup */
          }
        }
      }
    },
    { model: opts.model, cwd: opts.cwd, sandboxMode: opts.sandboxMode },
  );
}
