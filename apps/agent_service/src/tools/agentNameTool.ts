import { tool } from "@langchain/core/tools";
import { Agent } from "@scheduling-agent/database";
import { z } from "zod";

export function EditAgentNameTool(agentId: string) {
  return tool(
    async (input) => {
      const { name } = input;
      const agent = await Agent.findByPk(agentId);
      if (!agent) {
        return "Agent not found";
      }
      await agent.update({ agentName: name });
      return `Agent name has been updated to ${name}`;
    },
    {
      name: "edit_agent_name",
      description: "Updates the name of the agent",
      schema: z.object({
        name: z.string().min(1).describe("The new name of the agent"),
      }),
    },
  );
}