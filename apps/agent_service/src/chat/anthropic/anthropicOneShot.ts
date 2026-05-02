/**
 * One-shot Claude Agent SDK invocation for tool-less LLM calls.
 * Symmetric counterpart to `codexOneShot.ts` for the openai vendor.
 *
 * Why we need this even though `ChatAnthropic` already exists
 * ----------------------------------------------------------
 * `ChatAnthropic` (LangChain) accepts an `apiKey` and sends it as
 * `x-api-key`. That works for orgs whose `organization_vendor_api_keys`
 * row stores a classic API key (`sk-ant-api…`), but FAILS for orgs on
 * Claude OAuth tokens (`sk-ant-oat…`, the Pro/Max subscription billing
 * path) — those need the SDK's `CLAUDE_CODE_OAUTH_TOKEN` env var
 * instead. Routing summarization through the SDK fixes that gap and
 * matches the credential plumbing the graph runner
 * (`agentSdkRunner.ts`) already uses for full agent turns.
 *
 * Why no `mcpServers` / no tools
 * ------------------------------
 * Same reasoning as `codexOneShot`: this is a stateless, tool-less
 * call. The bridge is for graph turns that need our LangChain tool
 * surface; summarization just wants the model. No JWT, no registry,
 * no `mcp_server` round-trip.
 *
 * Structured output
 * -----------------
 * The Claude Agent SDK has no native `outputSchema` parameter (Codex's
 * `--output-schema` has no equivalent on the Anthropic side). When the
 * caller passes a `jsonSchemaHint` we append a strict instruction
 * block to the system prompt asking the model to reply with ONLY a
 * JSON object conforming to the schema, no prose. The caller is then
 * responsible for `JSON.parse` + Zod validation — same contract as the
 * Codex path's `sessionSummarizationSchema.parse(JSON.parse(json))`.
 * Less robust than ChatAnthropic's tool-use-backed `withStructuredOutput`,
 * but sufficient for the bounded summarization shape, and the only
 * option that works for OAuth-token orgs.
 *
 * Per-call SDK overhead
 * ---------------------
 * Each call spawns the bundled Claude Code subprocess via `su-exec
 * agent`. Cold-start is in the 100–500ms range. Acceptable for a
 * function called once per closed thread; would NOT be acceptable for
 * a hot-path call.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type {
  SpawnOptions,
  SpawnedProcess,
  query as queryFn,
} from "@anthropic-ai/claude-agent-sdk";

import { loadClaudeAgentSdk } from "./agentSdkLoader";
import { observeWithContext, recordSdkGeneration } from "../../langfuse";

const AGENT_USER = "agent";
const AGENT_HOME = "/home/agent";

export interface AnthropicOneShotOptions {
  /** Per-org Anthropic credential. May be an `sk-ant-api…` key or an
   *  `sk-ant-oat…` OAuth token — `keyType` discriminates. */
  credential: string;
  /** Source of truth for which env var receives the credential. null
   *  triggers a defensive prefix-sniff fallback (legacy rows). */
  keyType: "api_key" | "oauth_token" | null;
  /** Anthropic model slug, e.g. "claude-haiku-4-5". */
  model: string;
  /** Used as `options.systemPrompt` to the SDK call. */
  systemPrompt: string;
  /** The user-side prompt — passed as the SDK `prompt` field. */
  userPrompt: string;
  /**
   * Optional JSON Schema describing the expected response shape. When
   * set, the SDK's native `outputFormat: { type: 'json_schema', schema }`
   * is used — the SDK validates the model's response against the schema,
   * auto-retries on schema mismatch (up to its built-in retry limit),
   * and returns the parsed object on the result event's
   * `structured_output` field. This function then returns
   * `JSON.stringify(structured_output)` so the caller's existing
   * `JSON.parse(text)` flow keeps working unchanged.
   *
   * Retained as `jsonSchemaHint` (rather than `outputSchema`) for source
   * compatibility with existing callers (`sessionSummarization.ts`).
   */
  jsonSchemaHint?: unknown;
}

/**
 * Same env builder as `agentSdkRunner.buildSdkEnv` — duplicated here
 * deliberately so the one-shot path doesn't depend on the runner's
 * internal helper (the runner exports nothing at this level today).
 * Keeping the bodies in sync is a one-line concern; if/when we add a
 * shared `anthropicSdkEnv.ts`, both will pull from it.
 */
function buildSdkEnv(
  credential: string,
  keyType: "api_key" | "oauth_token" | null,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const trimmed = credential.trim();
  const resolvedType: "api_key" | "oauth_token" =
    keyType ?? (trimmed.startsWith("sk-ant-api") ? "api_key" : "oauth_token");
  if (resolvedType === "api_key") {
    env.ANTHROPIC_API_KEY = trimmed;
  } else {
    env.CLAUDE_CODE_OAUTH_TOKEN = trimmed;
  }

  if (process.env.MERIDIAN_URL) {
    env.ANTHROPIC_BASE_URL = process.env.MERIDIAN_URL;
  }
  env.HOME = AGENT_HOME;
  return env;
}

/**
 * Same as `agentSdkRunner.spawnClaudeCodeAsAgent` — wrap the spawned
 * Claude Code subprocess in `su-exec agent` so `bypassPermissions`
 * isn't rejected (the parent runs as root). Pulled in here so this
 * file is self-contained.
 */
function spawnClaudeCodeAsAgent(options: SpawnOptions): SpawnedProcess {
  return nodeSpawn("su-exec", [AGENT_USER, options.command, ...options.args], {
    cwd: options.cwd,
    env: {
      ...options.env,
      HOME: AGENT_HOME,
    },
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as SpawnedProcess;
}

/**
 * Coerces the JSON Schema we got from `zodToJsonSchema` into the
 * shape the SDK's `outputFormat` expects. Anthropic's spec is
 * `{ type: "json_schema", schema: { type: "object", properties, ... } }`.
 *
 * `zodToJsonSchema` wraps the inner schema in a `$schema`/`title` outer
 * envelope by default; the SDK accepts either form because `schema` is
 * typed as `Record<string, unknown>`, but we strip the outer wrapper
 * keys that aren't part of the JSON Schema spec to keep the payload
 * minimal. Falls through unchanged if the input doesn't look like a
 * JSON Schema object — the SDK will reject the call cleanly with a
 * config error in that case.
 */
function normaliseSchemaForOutputFormat(
  schema: unknown,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object" };
  }
  return schema as Record<string, unknown>;
}

/**
 * Belt-and-suspenders prompt block when structured output is requested.
 *
 * `outputFormat: { type: "json_schema", … }` is supposed to enforce the
 * schema natively, but in practice the bundled Claude Code CLI version
 * occasionally ignores it (we saw it return a markdown summary instead
 * of JSON for `claude-haiku-4-5` despite passing `outputFormat`). When
 * that happens, `structured_output` arrives undefined and the caller's
 * `JSON.parse(finalText)` fails on the raw markdown.
 *
 * Appending this instruction block to the system prompt costs ~150
 * tokens and gives us a soft fallback: if `outputFormat` engages, the
 * SDK validates strictly and `structured_output` populates as expected
 * (the prompt is harmless because the model is already constrained).
 * If `outputFormat` is ignored, the model still produces JSON in
 * `finalText` and the caller can parse it via `stripCodeFences` +
 * `JSON.parse`.
 */
function buildSchemaInstructionFallback(schema: unknown): string {
  let serialised: string;
  try {
    serialised = JSON.stringify(schema, null, 2);
  } catch {
    serialised = "(schema not serialisable)";
  }
  return (
    "\n\n## Output format\n" +
    "Respond with ONE JSON object that conforms to this JSON Schema. " +
    "Do not include prose, explanations, code fences, or markdown — " +
    "the entire response must be a single parseable JSON object.\n\n" +
    "```json\n" +
    serialised +
    "\n```"
  );
}

/**
 * Runs a single SDK turn with no tool surface and returns the final
 * assistant text. Throws on any SDK error so callers' try/catch
 * wrappers behave the same as for the legacy LangChain path.
 */
export async function runAnthropicOneShot(
  opts: AnthropicOneShotOptions,
): Promise<string> {
  return observeWithContext(
    "anthropic_one_shot",
    async () => {
      const sdk = await loadClaudeAgentSdk();

      const stderrLines: string[] = [];
      const onStderr = (data: string) => {
        const trimmed = (data ?? "").toString();
        if (stderrLines.join("\n").length + trimmed.length < 8192) {
          stderrLines.push(trimmed);
        }
      };

      // Native structured-output config for the SDK when a schema was
      // supplied. The SDK validates the response against the schema,
      // retries on mismatch (up to its built-in limit), and surfaces the
      // parsed object on the result event's `structured_output` field.
      // We ALSO append a prompt-level schema-instruction block as a
      // fallback — see `buildSchemaInstructionFallback` for the rationale.
      const outputFormat = opts.jsonSchemaHint
        ? {
            type: "json_schema" as const,
            schema: normaliseSchemaForOutputFormat(opts.jsonSchemaHint),
          }
        : undefined;
      const finalSystemPrompt = opts.jsonSchemaHint
        ? opts.systemPrompt + buildSchemaInstructionFallback(opts.jsonSchemaHint)
        : opts.systemPrompt;

      let finalText = "";
      let structuredOutput: unknown = undefined;
      let errorText: string | null = null;

      try {
        for await (const message of sdk.query({
          prompt: opts.userPrompt,
          options: {
            model: opts.model,
            systemPrompt: finalSystemPrompt,
            // Tool-less by design — no `mcpServers`, no `allowedTools`.
            // The model can only reply with text, which is exactly what
            // we want for a one-shot summarization / classification call.
            allowedTools: [],
            env: buildSdkEnv(opts.credential, opts.keyType),
            spawnClaudeCodeProcess: spawnClaudeCodeAsAgent,
            stderr: onStderr,
            // Bounded loop. Even with no tools the SDK uses `maxTurns` as
            // a safety net; 1 is enough since there's nothing to iterate
            // on.
            maxTurns: 1,
            // Same headless-server config as the runner. With no tools
            // exposed there's nothing dangerous to bypass — `permissionMode`
            // bypass + `allowDangerouslySkipPermissions` just stop the CLI
            // from refusing to start under a non-TTY parent process.
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            ...(outputFormat ? { outputFormat } : {}),
          },
        } as Parameters<typeof queryFn>[0])) {
          const msg = message as unknown as Record<string, unknown>;
          const type = typeof msg.type === "string" ? msg.type : null;
          if (type === "result") {
            const subtype = typeof msg.subtype === "string" ? msg.subtype : null;
            if (subtype === "success") {
              if (typeof msg.result === "string") finalText = msg.result;
              if ("structured_output" in msg) {
                structuredOutput = msg.structured_output;
              }
            } else if (subtype === "error_max_structured_output_retries") {
              errorText =
                "Anthropic SDK exhausted structured-output retries — the model could not produce a response matching the JSON schema.";
            } else {
              errorText =
                (typeof msg.result === "string" && msg.result) ||
                `Anthropic SDK returned non-success result: ${subtype ?? "unknown"}`;
            }
          }
        }
      } catch (err) {
        const baseMsg = err instanceof Error ? err.message : String(err);
        const stderrTail = stderrLines
          .join("")
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0)
          .slice(-20)
          .join("\n");
        errorText = stderrTail ? `${baseMsg}\n[stderr]\n${stderrTail}` : baseMsg;
      }

      // When the caller asked for structured output, prefer the SDK's
      // pre-validated object over the assistant's text — `structured_output`
      // is what the model actually produced after schema validation. We
      // serialise it back to a string so the function's return type
      // stays `Promise<string>` and the caller's `JSON.parse(text)`
      // flow continues to work without any change.
      //
      // When `outputFormat` was requested but `structured_output` came
      // back empty (the SDK silently ignored the schema, or the model
      // bypassed it), we fall through to `finalText` — the prompt
      // instruction we appended as a fallback should have produced JSON
      // there, which the caller will parse with `stripCodeFences`. We
      // log the situation at warn so the operator notices when the
      // native path isn't engaging.
      let returnText: string;
      if (outputFormat && structuredOutput !== undefined) {
        try {
          returnText = JSON.stringify(structuredOutput);
        } catch {
          returnText = finalText;
        }
      } else {
        if (outputFormat) {
          // Diagnostic so we can tell whether the bundled CLI is
          // honouring `outputFormat` or quietly ignoring it. Truncate
          // the preview because finalText can be quite large.
          const preview = finalText.length > 200
            ? finalText.slice(0, 200) + "…"
            : finalText;
          // eslint-disable-next-line no-console
          console.warn(
            "[anthropicOneShot] outputFormat was set but structured_output was empty — " +
              "falling back to finalText (likely SDK/CLI ignored outputFormat). " +
              `model=${opts.model} finalTextPreview=${JSON.stringify(preview)}`,
          );
        }
        returnText = finalText;
      }

      if (errorText && !returnText) {
        throw new Error(errorText);
      }

      // Langfuse: emit a single generation span for the model call —
      // matches the LangChain CallbackHandler shape that legacy
      // ChatAnthropic calls produced. Input is structured as a
      // `messages` array so the trace shows system + user prompts as
      // distinct chat turns, mirroring the runner-level outer span
      // shape.
      recordSdkGeneration({
        name: "anthropic_one_shot_generation",
        model: opts.model,
        input: {
          messages: [
            { role: "system", content: finalSystemPrompt },
            { role: "user", content: opts.userPrompt },
          ],
        },
        output: returnText,
        metadata: {
          vendor: "anthropic",
          structured: !!outputFormat,
          structuredOutputUsed: structuredOutput !== undefined,
        },
      });

      return returnText;
    },
    { model: opts.model, hasSchema: !!opts.jsonSchemaHint },
  );
}
