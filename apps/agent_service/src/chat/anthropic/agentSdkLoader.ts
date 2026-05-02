/**
 * Lazy loader for `@anthropic-ai/claude-agent-sdk`.
 *
 * The SDK ships as an ESM-only package (`"type": "module"` with no CJS build),
 * but `apps/agent_service` compiles to CommonJS (see `tsconfig.base.json` →
 * `"module": "commonjs"`). With CommonJS output, TypeScript lowers a static
 * `import { query } from "@anthropic-ai/claude-agent-sdk"` into
 * `require("@anthropic-ai/claude-agent-sdk")` — which throws
 * `ERR_REQUIRE_ESM` at runtime.
 *
 * The fix is to load the SDK via a real dynamic `import()` that is *not*
 * down-compiled. The `Function`-constructor escape below builds a fresh
 * function whose body is the literal `import(specifier)` expression, which
 * Node then evaluates as a true ECMAScript dynamic import. TypeScript leaves
 * the eval'd source string alone, so the runtime semantics survive the
 * CommonJS lowering.
 *
 * Type-only imports of SDK types still go through normal `import type`
 * statements — those are erased at compile time and have no runtime cost.
 *
 * The result is cached so we only pay the dynamic-import once per process.
 */

import type { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

interface ClaudeAgentSdkModule {
  query: typeof query;
  tool: typeof tool;
  createSdkMcpServer: typeof createSdkMcpServer;
}

/** Fresh-Function escape: avoids TypeScript's import-to-require lowering. */
const dynamicImport = new Function(
  "specifier",
  "return import(specifier);",
) as <T>(specifier: string) => Promise<T>;

let cached: Promise<ClaudeAgentSdkModule> | null = null;

/**
 * Returns the SDK module, loading it on first call. Safe to invoke repeatedly
 * — subsequent calls resolve to the same cached promise.
 */
export function loadClaudeAgentSdk(): Promise<ClaudeAgentSdkModule> {
  if (!cached) {
    cached = dynamicImport<ClaudeAgentSdkModule>(
      "@anthropic-ai/claude-agent-sdk",
    );
  }
  return cached;
}
