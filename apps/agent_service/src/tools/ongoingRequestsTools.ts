import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { addOngoingRequest, removeOngoingRequest } from "../sessionsManagment/ongoingRequestsManager";

/**
 * Records a multi-step or deferred user ask in `agents.ongoing_requests` so it stays visible across turns and users.
 */
export function createAddOngoingRequestTool(agentId: string, userId: number) {
  return tool(
    async (input) => {
      const { request } = input;
      const entry = await addOngoingRequest(agentId, userId, request);
      if (entry) {
        return (
          `Ongoing request recorded (id=${entry.id}, userId=${entry.userId}). ` +
          "It will appear in context for this agent until removed."
        );
      }
      return "Failed to add ongoing request. Check logs or try again.";
    },
    {
      name: "add_ongoing_request",
      description:
        "Stores a user request that is not finished in one reply (follow-ups, pending tasks, reminders). " +
        "It is attached to this agent and shown in the system prompt to all conversations for this agent. " +
        "Use when the user asks for something that should stay on your radar across messages.",
      schema: z.object({
        request: z
          .string()
          .min(1)
          .describe("Clear description of what remains to be done or followed up on."),
      }),
    },
  );
}

/**
 * Removes an entry from `agents.ongoing_requests` after it has been fulfilled.
 */
export function createRemoveOngoingRequestTool(agentId: string) {
  return tool(
    async (input) => {
      const { request_id } = input;
      const ok = await removeOngoingRequest(agentId, request_id);
      if (ok) {
        return `Ongoing request ${request_id} has been removed.`;
      }
      return `No ongoing request found with id "${request_id}" (or removal failed).`;
    },
    {
      name: "remove_ongoing_request",
      description:
        "Removes an ongoing request from this agent's list after you have fully completed or resolved it. " +
        "Use the `id` string shown in the Ongoing requests section of the system prompt.",
      schema: z.object({
        request_id: z.string().min(1).describe("The `id` field of the ongoing request to remove."),
      }),
    },
  );
}
