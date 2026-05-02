/**
 * Shared Anthropic server-side context-management config.
 *
 * Enables `clear_tool_uses_20250919` (gated by the `context-management-2025-06-27`
 * beta) so Anthropic automatically replaces older `tool_result` payloads with a
 * short placeholder once the running prompt grows past the trigger threshold,
 * while preserving the `tool_use` record so the model still knows the call
 * happened. Cuts context bloat on long tool-heavy threads with zero inference
 * overhead. The actual payloads stay in our LangGraph checkpoint; only the
 * copy sent to the Anthropic server on each turn is trimmed.
 *
 * Thresholds can be overridden via env without a code change:
 *   ANTHROPIC_CLEAR_TOOL_USES_TRIGGER_TOKENS   (default 30_000)
 *   ANTHROPIC_CLEAR_TOOL_USES_KEEP             (default 4)
 *   ANTHROPIC_CLEAR_TOOL_USES_AT_LEAST_TOKENS  (default 5_000)
 *
 * Usage:
 *   new ChatAnthropic({
 *     ...,
 *     ...anthropicBaseConfig(),
 *   })
 * which spreads `betas` + `contextManagement` in one place.
 */

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function anthropicContextManagement() {
  return {
    edits: [
      {
        type: "clear_tool_uses_20250919" as const,
        trigger: {
          type: "input_tokens" as const,
          value: parsePositiveInt(
            process.env.ANTHROPIC_CLEAR_TOOL_USES_TRIGGER_TOKENS,
            30_000,
          ),
        },
        keep: {
          type: "tool_uses" as const,
          value: parsePositiveInt(
            process.env.ANTHROPIC_CLEAR_TOOL_USES_KEEP,
            4,
          ),
        },
        clear_at_least: {
          type: "input_tokens" as const,
          value: parsePositiveInt(
            process.env.ANTHROPIC_CLEAR_TOOL_USES_AT_LEAST_TOKENS,
            5_000,
          ),
        },
      },
    ],
  };
}

/**
 * The `clear_tool_uses_20250919` edit is gated by the
 * `context-management-2025-06-27` beta header. Unlike compaction, the
 * @langchain/anthropic wrapper does NOT auto-enable this header, so every
 * `ChatAnthropic` construction that wants tool-use clearing must pass it.
 */
export const ANTHROPIC_CONTEXT_MANAGEMENT_BETAS = [
  "context-management-2025-06-27",
] as const;

/**
 * Convenience: spread-friendly bundle of the two fields every Anthropic model
 * construction needs to opt in to server-side tool-result clearing.
 *
 *   new ChatAnthropic({ ..., ...anthropicBaseConfig() })
 */
export function anthropicBaseConfig() {
  return {
    betas: [...ANTHROPIC_CONTEXT_MANAGEMENT_BETAS],
    contextManagement: anthropicContextManagement(),
  };
}
