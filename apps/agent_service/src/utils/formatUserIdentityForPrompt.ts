import type { UserIdentity } from "@scheduling-agent/types";

/**
 * Renders `users.user_identity` JSON for LLM system prompts. Nested objects
 * are flattened with dotted keys so values are never `[object Object]`.
 */
export function formatUserIdentityForPrompt(
  identity: UserIdentity | null | undefined,
): string {
  if (!identity || typeof identity !== "object") return "";

  const lines: string[] = [];

  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      if (v === null) {
        lines.push(`- **${path}:** null`);
        continue;
      }
      if (typeof v === "object" && !Array.isArray(v)) {
        walk(v as Record<string, unknown>, path);
      } else {
        const display = Array.isArray(v)
          ? JSON.stringify(v)
          : typeof v === "object"
            ? JSON.stringify(v)
            : String(v);
        lines.push(`- **${path}:** ${display}`);
      }
    }
  };

  walk(identity as Record<string, unknown>, "");
  return lines.join("\n");
}
