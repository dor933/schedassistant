import {
  Agent,
  Organization,
} from "@scheduling-agent/database";
import { type WebSearchChoice } from "@scheduling-agent/types";
import { logger } from "../../logger";
import { getIO } from "../../sockets/server/socketServer";

/**
 * Resolves which of the two per-org web-search system agents is currently
 * active for an organization, and flips between them. Each organization
 * has its own pair (Gemini + Brave) seeded on org creation — identified
 * by slug, not by a global UUID.
 */
const GEMINI_SLUG = "web_search";
const BRAVE_SLUG = "web_search_brave";

interface CandidateShape {
  id: string;
  slug: string | null;
  agentName: string | null;
  description: string | null;
  modelSlug: string | null;
}

function toCandidate(agent: Agent | null): CandidateShape | null {
  if (!agent) return null;
  return {
    id: agent.id,
    slug: agent.slug,
    agentName: agent.agentName,
    description: agent.description,
    modelSlug: agent.modelSlug,
  };
}

export class WebSearchAgentService {
  /** Raw shape returned to the admin UI + onboarding wizard. */
  async get(organizationId: string) {
    const [org, agents] = await Promise.all([
      Organization.findByPk(organizationId, {
        attributes: ["id", "webSearchAgentId"],
      }),
      Agent.findAll({
        where: {
          organizationId,
          type: "system",
          slug: [GEMINI_SLUG, BRAVE_SLUG],
        },
        attributes: ["id", "slug", "agentName", "description", "modelSlug"],
      }),
    ]);
    if (!org) {
      throw Object.assign(new Error("Organization not found."), { status: 404 });
    }

    const bySlug = new Map(agents.map((a) => [a.slug, a]));
    const gemini = bySlug.get(GEMINI_SLUG) ?? null;
    const brave = bySlug.get(BRAVE_SLUG) ?? null;

    const activeId = org.webSearchAgentId ?? gemini?.id ?? brave?.id ?? null;
    const activeChoice: WebSearchChoice =
      brave && activeId === brave.id ? "brave" : "gemini";

    return {
      activeChoice,
      activeAgentId: activeId,
      candidates: {
        gemini: toCandidate(gemini),
        brave: toCandidate(brave),
      },
    };
  }

  /** Sets exactly one of the two web-search agents as active for this org. */
  async set(organizationId: string, choice: WebSearchChoice) {
    const org = await Organization.findByPk(organizationId);
    if (!org) {
      throw Object.assign(new Error("Organization not found."), { status: 404 });
    }

    const targetSlug = choice === "brave" ? BRAVE_SLUG : GEMINI_SLUG;
    const target = await Agent.findOne({
      where: { organizationId, type: "system", slug: targetSlug },
      attributes: ["id"],
    });
    if (!target) {
      throw Object.assign(
        new Error(
          `No "${targetSlug}" web-search agent exists for this organization.`,
        ),
        { status: 404 },
      );
    }

    if (org.webSearchAgentId === target.id) {
      return this.get(organizationId);
    }

    await org.update({ webSearchAgentId: target.id });

    try {
      getIO().emit("admin:change", {
        type: "web_search_agent_changed",
        message: `Web search agent switched to ${choice}.`,
        data: { organizationId, choice, agentId: target.id },
      });
    } catch (err) {
      logger.error("broadcast web_search_agent_changed failed", {
        error: String(err),
      });
    }

    return this.get(organizationId);
  }
}
