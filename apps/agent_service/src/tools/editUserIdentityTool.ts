import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { updateUserIdentity } from "../sessionsManagment/userIdentityManager";

/**
 * LangChain tool factory: updates `users.user_identity` (JSONB) for the **current** thread user.
 * `userId` is fixed by the server from graph state — the model only chooses action + content.
 */
export function EditUserIdentityTool(userId: number) {
  return tool(
    async (input) => {
      const { action, content } = input;
      const success = await updateUserIdentity(userId, action, content);
      if (success) {
        return `User identity has been updated (action: ${action}).`;
      }
      return "Failed to update user identity. Check logs for details.";
    },
    {
      name: "edit_user_identity",
      description:
        "Updates this user's persistent row in the database: `users.user_identity` (JSONB). " +
        "Use a JSON **object** string for structured data. Action `rewrite` replaces the entire object; " +
        "`append` shallow-merges new keys into the existing object. " +
        "If you send plain text instead of JSON, it is stored under the `userIdentity` field (append concatenates).",
      schema: z.object({
        action: z
          .enum(["append", "rewrite"])
          .describe(
            "'rewrite' replaces user_identity (use JSON object). " +
              "'append' merges a JSON object into existing user_identity.",
          ),
        content: z
          .string()
          .describe(
            "JSON object string, e.g. {\"timezone\":\"UTC\",\"preferredName\":\"Alex\"}. " +
              "For rewrite, the full object; for append, keys to merge.",
          ),
      }),
    },
  );
}
