import { Organization } from "@scheduling-agent/database";
import { type UserId } from "@scheduling-agent/types";
import { logger } from "../../logger";
import { getIO } from "../../sockets/server/socketServer";

/**
 * Admin-facing read/write for organization-level settings that aren't covered
 * by the dedicated admin routers (users, agents, etc.). Right now this is
 * just the free-text `summary` blurb that gets prepended to every agent's
 * system prompt, but this is the place to grow org-level metadata.
 */
export class OrganizationService {
  async get(organizationId: string) {
    const org = await Organization.findByPk(organizationId, {
      attributes: ["id", "name", "summary"],
    });
    if (!org) {
      throw Object.assign(new Error("Organization not found."), { status: 404 });
    }
    return {
      id: org.id,
      name: org.name,
      summary: org.summary ?? "",
    };
  }

  /**
   * Sets (or clears, when `summary` is empty/whitespace) the admin-authored
   * org summary. Empty strings are normalized to `null` in the DB.
   */
  async setSummary(organizationId: string, summary: string, actorId: UserId) {
    const org = await Organization.findByPk(organizationId);
    if (!org) {
      throw Object.assign(new Error("Organization not found."), { status: 404 });
    }

    const trimmed = summary.trim();
    const next = trimmed.length === 0 ? null : trimmed;
    if (org.summary === next) {
      return this.get(organizationId);
    }

    await org.update({ summary: next });

    const fresh = await this.get(organizationId);

    try {
      getIO().emit("admin:change", {
        type: "organization_summary_changed",
        message: next
          ? "Organization summary updated."
          : "Organization summary cleared.",
        data: { organizationId, organization: fresh },
        actorId,
      });
    } catch (err) {
      logger.error("broadcast organization_summary_changed failed", {
        error: String(err),
      });
    }

    return fresh;
  }
}
