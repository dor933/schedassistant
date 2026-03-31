import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { updateCoreMemory } from "../sessionsManagment/coreMemoryManager";

/**
 * LangChain tool factory: updates `users.user_identity` (JSONB) for the **current** thread user.
 * `userId` is fixed by the server from graph state — the model only chooses action + content.
 */
export function createEditCoreMemoryTool(userId: number) {
  return tool(
    async (input) => {
      const { action, content } = input;
      const success = await updateCoreMemory(userId, action, content);
      if (success) {
        return `Core memory (user_identity) has been updated (action: ${action}).`;
      }
      return "Failed to update core memory. Check logs for details.";
    },
    {
      name: "edit_core_memory",
      description:
        "Updates this user's persistent row in the database: `users.user_identity` (JSONB). " +
        "Use a JSON **object** string for structured data. Action `rewrite` replaces the entire object; " +
        "`append` shallow-merges new keys into the existing object. " +
        "If you send plain text instead of JSON, it is stored under the `agentNotes` field (append concatenates). " +
        "Use for long-term preferences and facts only — not one-off chat. Episodic memory holds transient context.",
      schema: z.object({
        action: z
          .enum(["append", "rewrite"])
          .describe(
            "'rewrite' replaces user_identity (use JSON object). " +
              "'append' merges a JSON object into existing user_identity, or appends plain text to agentNotes.",
          ),
        content: z
          .string()
          .describe(
            "JSON object string, e.g. {\"timezone\":\"UTC\",\"preferredName\":\"Alex\"}. " +
              "For rewrite, the full object; for append, keys to merge. Plain text merges into agentNotes.",
          ),
      }),
    },
  );
}
