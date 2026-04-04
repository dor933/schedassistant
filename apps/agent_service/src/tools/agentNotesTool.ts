import { tool } from "@langchain/core/tools";
import { Agent } from "@scheduling-agent/database";
import { z } from "zod";

/**
 * Reads the agent's persistent notes.
 */
export function ReadAgentNotesTool(agentId: string) {
  return tool(
    async () => {
      const agent = await Agent.findByPk(agentId, { attributes: ["id", "agentNotes"] });
      if (!agent) return "Agent not found";

      const notes = agent.agentNotes?.trim();
      if (!notes) return "No notes yet.";
      return `Current notes:\n${notes}`;
    },
    {
      name: "read_agent_notes",
      description:
        "Reads your current persistent notes. " +
        "Use this to review what you've previously saved — including pending tasks, follow-ups, " +
        "project details, user preferences, or any other information you chose to remember. " +
        "Your notes are also shown in your system prompt under 'Agent notes', but use this tool " +
        "to get the latest version if you've recently updated them.",
      schema: z.object({}),
    },
  );
}

/**
 * Appends text to the agent's persistent notes.
 * If notes are empty, the text becomes the initial content.
 */
export function AppendAgentNotesTool(agentId: string) {
  return tool(
    async (input) => {
      const agent = await Agent.findByPk(agentId, { attributes: ["id", "agentNotes"] });
      if (!agent) return "Agent not found";

      const existing = agent.agentNotes?.trim() ?? "";
      const updated = existing
        ? `${existing}\n${input.text}`
        : input.text;

      await agent.update({ agentNotes: updated });
      return `Notes updated. Current notes:\n${updated}`;
    },
    {
      name: "append_agent_notes",
      description:
        "Appends important information to your persistent notes. " +
        "Use this when you learn something worth remembering across conversations — " +
        "e.g. pending tasks or follow-ups from users, project details, repo URLs, key decisions, " +
        "user preferences, or anything that should stay on your radar. " +
        "The text is appended to any existing notes.",
      schema: z.object({
        text: z
          .string()
          .min(1)
          .describe("The text to append to your notes"),
      }),
    },
  );
}

/**
 * Replaces the entire agent notes with an edited version.
 * The agent should first read the current notes (returned in the system prompt),
 * then provide the corrected full text.
 */
export function EditAgentNotesTool(agentId: string) {
  return tool(
    async (input) => {
      const agent = await Agent.findByPk(agentId, { attributes: ["id", "agentNotes"] });
      if (!agent) return "Agent not found";

      const newText = input.text.trim();
      await agent.update({ agentNotes: newText || null });

      if (!newText) return "Notes cleared.";
      return `Notes replaced. Current notes:\n${newText}`;
    },
    {
      name: "edit_agent_notes",
      description:
        "Replaces your entire persistent notes with the provided text. " +
        "Use this to correct, reorganize, or remove outdated information from your notes. " +
        "For example, remove completed tasks, update stale info, or restructure your notes. " +
        "First review your current notes (shown in your system prompt under 'Agent notes'), " +
        "then provide the full corrected version. Pass an empty string to clear all notes.",
      schema: z.object({
        text: z
          .string()
          .describe(
            "The full replacement text for your notes. " +
            "This overwrites everything — include any existing content you want to keep.",
          ),
      }),
    },
  );
}
