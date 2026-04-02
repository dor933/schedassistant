import { Agent, LLMModel } from "@scheduling-agent/database";
import { logger } from "../logger";

/**
 * Resolves the LLM model slug for a conversation turn from the agent's configured model.
 * Falls back to "gpt-4o" if no model is set on the agent.
 */
export async function resolveModelSlug(
  agentId?: string | null,
): Promise<string> {
  try {
    if (agentId) {
      const agent = await Agent.findByPk(agentId, { attributes: ["modelId"] });
      if (agent?.modelId) {
        const model = await LLMModel.findByPk(agent.modelId, { attributes: ["slug"] });
        if (model) {
          logger.info("Model resolved from agent", { agentId, slug: model.slug });
          return model.slug;
        }
      }
    }
  } catch {
    // Fall through to default
  }
  return "gpt-4o";
}
