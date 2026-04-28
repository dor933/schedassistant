import { Agent } from "@scheduling-agent/database";
import { loadOrganizationSummarySection } from "../../basicGraph/nodes/contextBuilder";
import { logger } from "../../../logger";
import { ApplicationAgentState } from "../state";

/**
 * Assembles the system prompt for an application-agent invocation.
 *
 * Composition (top → bottom):
 *   1. Organization summary block (shared across every agent in the org).
 *   2. Application agent's own `instructions` field (the dedicated system
 *      prompt — content TBD by the user; for now whatever lives in the DB
 *      row is used as-is).
 *
 * Rejects the invocation if the agent row doesn't exist or isn't of type
 * 'application' (defensive — the controller already checks, but the graph
 * shouldn't trust upstream).
 */
export async function applicationContextBuilderNode(
  state: ApplicationAgentState,
): Promise<Partial<ApplicationAgentState>> {
  const { agentId } = state;

  if (!agentId) {
    return { error: "applicationContextBuilder: agentId missing from state." };
  }

  const agent = await Agent.findByPk(agentId, {
    attributes: ["id", "type", "instructions", "agentName", "organizationId"],
  });

  if (!agent) {
    return { error: `applicationContextBuilder: agent "${agentId}" not found.` };
  }
  if (agent.type !== "application") {
    return {
      error:
        `applicationContextBuilder: agent "${agentId}" has type "${agent.type}", ` +
        `expected "application".`,
    };
  }

  const orgSection = await loadOrganizationSummarySection(agent.organizationId ?? null);
  const orgBlock = orgSection.trim().length > 0 ? `${orgSection.trim()}\n\n` : "";

  // The dedicated system prompt lives on `agents.instructions`. Left empty for
  // now — the user will populate it from the admin UI / a seed migration after
  // the infrastructure lands.
  const dedicatedInstructions = (agent.instructions ?? "").trim();

  // Standard guidance on how this application agent talks to primary agents.
  // Always appended (the consult tools are always bound) so the LLM knows the
  // available channel and its constraints.
  const interactionBlock = [
    "## Talking to primary agents",
    "You are an application agent — REST-triggered, stateless, one-shot per request. " +
      "You can reach the organization's **primary agents** (orchestrators with their own " +
      "memory and conversation history) when their expertise would help answer the user's " +
      "question. The request you received represents a real end-user question forwarded " +
      "by an upstream application that handles authentication; the user's identity is " +
      "carried with you into any consultation.",
    "",
    "- Use `list_agents` to discover which primary agents exist (system, external, and " +
      "other application agents are intentionally excluded — they are not consultable).",
    "- Use `consult_agent` with the target agent's id to send a synchronous request and " +
      "receive their answer inline. The target sees your request as `[Consultation request " +
      "from another agent]`.",
    "- Consultations are **synchronous** — your turn waits for the answer (up to ~5 min). " +
      "Use them sparingly: only when the primary agent has memory, context, or specialist " +
      "knowledge you genuinely need. For pure data lookups, prefer `query_database`.",
    "- Do **not** attempt to consult system, external, or other application agents — those " +
      "are blocked at the tool level.",
    "",
  ].join("\n");

  const systemPrompt = `${orgBlock}${dedicatedInstructions}\n\n${interactionBlock}`.trim();

  logger.info("ApplicationGraph: context built", {
    agentId,
    agentName: agent.agentName,
    promptLength: systemPrompt.length,
  });

  return { systemPrompt };
}
