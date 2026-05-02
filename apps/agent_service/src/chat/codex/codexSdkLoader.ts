/**
 * Lazy loader for `@openai/codex-sdk`.
 *
 * Same constraint as `agentSdkLoader.ts`: the SDK ships ESM-only
 * (`"type": "module"`, no CJS build), but `agent_service` compiles to
 * CommonJS. A static `import` would be lowered to `require()` and throw
 * `ERR_REQUIRE_ESM` at runtime. The Function-constructor escape below
 * builds a function whose body is a literal `import(specifier)`
 * expression that TypeScript leaves alone, so Node evaluates it as a
 * real ECMAScript dynamic import.
 *
 * Type-only imports of SDK types still go through normal `import type`
 * — those are erased at compile time.
 */

import type { Codex } from "@openai/codex-sdk";

interface CodexSdkModule {
  Codex: typeof Codex;
}

/** Fresh-Function escape: avoids TypeScript's import-to-require lowering. */
const dynamicImport = new Function(
  "specifier",
  "return import(specifier);",
) as <T>(specifier: string) => Promise<T>;

let cached: Promise<CodexSdkModule> | null = null;

/**
 * Returns the SDK module, loading it on first call. Safe to invoke
 * repeatedly — subsequent calls resolve to the same cached promise.
 */
export function loadCodexSdk(): Promise<CodexSdkModule> {
  if (!cached) {
    cached = dynamicImport<CodexSdkModule>("@openai/codex-sdk");
  }
  return cached;
}
