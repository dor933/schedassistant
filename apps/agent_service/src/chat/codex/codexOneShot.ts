/**
 * One-shot Codex SDK invocation for tool-less LLM calls (summarization,
 * structured classification, etc.).
 *
 * Why not reuse `codexSdkRunner`?
 * The runner is graph-aware: it reads/writes `Thread.codexThreadId`,
 * registers a tool list against the bridge, mints a JWT, drains the
 * session-file ledger, etc. None of that applies to a stateless
 * one-shot call. We bypass the bridge entirely (no `mcp_servers`
 * config) so the spawned `codex` CLI runs without any tool surface —
 * the model has nothing to invoke and produces the answer directly.
 *
 * Why this lives here (and not inline in each caller)
 * --------------------------------------------------
 * Both `sessionSummarization` and the roundtable summarizer want the
 * exact same shape: pick a vendor-appropriate model, scrub env, build
 * a `Codex` client with the per-org credential, prepend the system
 * prompt, optionally pass an `outputSchema`, and return the final
 * response. Centralising prevents both call sites from re-implementing
 * the env-scrub + dynamic-import dance and keeps the credential
 * handling auditable in one place.
 */

import type { CodexOptions, ThreadOptions } from "@openai/codex-sdk";

import { loadCodexSdk } from "./codexSdkLoader";
import { observeWithContext, recordSdkGeneration } from "../../langfuse";
import { materialiseCodexHome } from "../../utils/codexAuthJson.service";

const AGENT_HOME = "/home/agent";

export interface CodexOneShotOptions {
  /** Per-org OpenAI API key. Optional — when null, the caller must
   *  supply `authObject` instead. */
  apiKey?: string | null;
  /** Per-org Codex CLI auth.json blob (ChatGPT-account login).
   *  Optional — when present, materialised to a Codex-compatible $HOME
   *  for the spawned CLI to read. Mutually exclusive with `apiKey`
   *  in practice (matches the row-level CHECK on
   *  `organization_vendor_api_keys`). */
  authObject?: Record<string, unknown> | null;
  /** Organization id for authObject. When supplied, Codex uses the
   *  persistent per-org home under the agent Codex volume. */
  authObjectOrganizationId?: string | null;
  /** Model slug — e.g. "gpt-4o" for cheap summarization, or whatever the
   *  caller's pricing tier wants. */
  model: string;
  /** Prepended to the user input as `# System\n…\n\n# Task\n…`. */
  systemPrompt: string;
  /** The user-side prompt. */
  userPrompt: string;
  /** Optional JSON Schema describing the expected response shape. When
   *  set, the SDK passes it as `--output-schema` to the CLI and the
   *  resulting `finalResponse` is JSON conforming to the schema. */
  outputSchema?: unknown;
  /** Optional working directory for the spawned CLI. Defaults to
   *  `/home/agent` so the CLI's writes (cache, sessions) land on the
   *  persistent named volume. */
  workingDirectory?: string;
}

/**
 * Replaces `process.env` for the spawned `codex` subprocess with a
 * scrubbed view that pins the org credential. Same defense-in-depth as
 * `codexSdkRunner.buildCodexEnv` — no inherited deployment-level
 * `OPENAI_API_KEY` / `CODEX_API_KEY` can override the per-org key.
 *
 * When `apiKey` is null (auth_object path), OPENAI_API_KEY is left
 * unset — the CLI then falls through to reading `auth.json` from
 * $HOME, which `homeDir` points at (per-turn temp dir).
 */
function buildOneShotEnv(args: {
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

/**
 * Runs a single Codex turn with no tool surface and returns the final
 * response text. Throws on Codex errors (caller catches — same shape
 * as a thrown LangChain LLM error so existing try/catch wrappers in
 * the callers continue to work).
 */
export async function runCodexOneShot(
  opts: CodexOneShotOptions,
): Promise<string> {
  // Validate caller supplied at least one credential. We treat the
  // auth_object path as preferable when both are present (same rule as
  // the runner — explicit ChatGPT-account login wins over the API key
  // billing path).
  if (!opts.apiKey && !opts.authObject) {
    throw new Error(
      "runCodexOneShot: caller must supply either `apiKey` or `authObject`.",
    );
  }
  const useAuthObject = !!opts.authObject;
  const effectiveApiKey = useAuthObject ? null : (opts.apiKey ?? null);

  return observeWithContext(
    "codex_one_shot",
    async () => {
      const sdk = await loadCodexSdk();

      const materialised = useAuthObject
        ? await materialiseCodexHome(opts.authObject as Record<string, unknown>, {
            organizationId: opts.authObjectOrganizationId ?? null,
          })
        : null;
      try {
        const codexOptions: CodexOptions = {
          ...(effectiveApiKey ? { apiKey: effectiveApiKey } : {}),
          env: buildOneShotEnv({
            apiKey: effectiveApiKey,
            homeDir: materialised ? materialised.homeDir : null,
          }),
          ...(process.env.MERIDIAN_URL ? { baseUrl: process.env.MERIDIAN_URL } : {}),
          // No `mcp_servers` — tool-less by design. The bridge is for graph
          // turns that need our LangChain tool surface; summarization and
          // classification just want the model.
        };

        const threadOptions: ThreadOptions = {
          model: opts.model,
          workingDirectory: opts.workingDirectory ?? AGENT_HOME,
          skipGitRepoCheck: true,
          sandboxMode: "danger-full-access",
          approvalPolicy: "never",
        };

        const codex = new sdk.Codex(codexOptions);
        const thread = codex.startThread(threadOptions);

        // Codex has no `systemPrompt` option; same convention as
        // codexSdkRunner / codexAdapter on the CLI tool path.
        const prompt = `# System\n${opts.systemPrompt}\n\n# Task\n${opts.userPrompt}`;

        const turn = await thread.run(prompt, {
          ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
        });

        // Langfuse: emit a single generation span for the model call —
        // matches the LangChain CallbackHandler shape that legacy
        // ChatOpenAI calls produced. Input is structured as a `messages`
        // array so the trace shows system + user prompts as distinct
        // chat turns, mirroring the runner-level outer span shape.
        recordSdkGeneration({
          name: "codex_one_shot_generation",
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
            structured: !!opts.outputSchema,
            authPath: useAuthObject ? "auth_object" : "api_key",
          },
        });

        return turn.finalResponse;
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
    { model: opts.model, hasSchema: !!opts.outputSchema },
  );
}
