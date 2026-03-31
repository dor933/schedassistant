import type { UserIdentity } from "@scheduling-agent/types";

/**
 * Renders `users.user_identity` for LLM system prompts.
 * Uses pretty-printed JSON so nested structures never appear as `[object Object]`.
 */
export function formatUserIdentityForPrompt(
  identity: UserIdentity | null | undefined,
): string {
  if (identity == null) return "";

  let data: unknown = identity;

  if (typeof data === "string") {
    const t = data.trim();
    if (!t) return "";
    try {
      data = JSON.parse(t) as unknown;
    } catch {
      return `- **profile:** ${t}`;
    }
  }

  if (typeof data !== "object" || data === null) {
    return `- **profile:** ${String(data)}`;
  }

  try {
    const json = JSON.stringify(data, null, 2);
    if (!json || json === "{}") return "";
    return ["```json", json, "```"].join("\n");
  } catch {
    return "- **profile:** (could not serialize — possibly circular data)";
  }
}
