import { User } from "@scheduling-agent/database";
import type { UserIdentity, UserId } from "@scheduling-agent/types";
import { formatUserIdentityForPrompt } from "../utils/formatUserIdentityForPrompt";
import { logger } from "../logger";

const EMPTY_PLACEHOLDER = "No core memory entries yet.";

/** Freeform text is stored under this key when `content` is not valid JSON. */
const FREEFORM_KEY = "agentNotes";

function tryParseIdentityObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON
  }
  return null;
}

/**
 * Reads formatted core context from `users.user_identity` (JSONB).
 *
 * - **Single chat:** full identity for `userId`.
 * - **Group chat:** empty string — per-member identity is under **Group chat / Members** in `contextBuilder`.
 */
export async function getUserIdentity(
  userId: UserId,
  groupId: string | null | undefined,
): Promise<string> {
  if (groupId) {
    return "";
  }

  try {
    const user = await User.findByPk(userId, { attributes: ["userIdentity"] });
    const idPart = formatUserIdentityForPrompt(user?.userIdentity ?? null);
    return idPart || EMPTY_PLACEHOLDER;
  } catch (err) {
    logger.error("Failed to load user_identity for core memory", { userId, error: String(err) });
    return EMPTY_PLACEHOLDER;
  }
}

/**
 * Updates `users.user_identity` via the `edit_core_memory` tool.
 *
 * - **`rewrite`:** `content` should be a **JSON object** string — replaces `user_identity` entirely.
 *   If `content` is not valid JSON, it is stored as `{ "agentNotes": "<content>" }`.
 * - **`append`:** `content` should be a **JSON object** string — shallow-merged into the existing
 *   `user_identity`. If not valid JSON, the text is appended to the `agentNotes` string field.
 */
export async function updateUserIdentity(
  userId: UserId,
  action: "append" | "rewrite",
  content: string,
): Promise<boolean> {
  try {
    const user = await User.findByPk(userId, { attributes: ["id", "userIdentity"] });
    if (!user) {
      logger.error("updateUserIdentity: user not found", { userId });
      return false;
    }

    const existing = (user.userIdentity ?? {}) as UserIdentity & Record<string, unknown>;
    const parsed = tryParseIdentityObject(content.trim());

    if (parsed) {
      const next: UserIdentity =
        action === "rewrite"
          ? (parsed as UserIdentity)
          : ({ ...existing, ...parsed } as UserIdentity);
      await user.update({ userIdentity: next });
      return true;
    }

    // Plain text fallback
    if (action === "rewrite") {
      await user.update({ userIdentity: { [FREEFORM_KEY]: content } as UserIdentity });
      return true;
    }

    const prev =
      typeof existing[FREEFORM_KEY] === "string" ? (existing[FREEFORM_KEY] as string) : "";
    const merged = `${prev}${prev ? "\n\n" : ""}${content}`;
    await user.update({
      userIdentity: { ...existing, [FREEFORM_KEY]: merged } as UserIdentity,
    });
    return true;
  } catch (err) {
    logger.error(`User identity ${action} failed`, { userId, error: String(err) });
    return false;
  }
}
