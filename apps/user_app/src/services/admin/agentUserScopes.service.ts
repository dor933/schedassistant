import { Op } from "sequelize";
import { Agent, AgentUserScope, User } from "@scheduling-agent/database";
import type {
  AgentId,
  AgentUserScopeAttributes,
  GoogleScope,
  OrganizationId,
  UserId,
} from "@scheduling-agent/types";
import { getIO } from "../../sockets/server/socketServer";
import { logger } from "../../logger";

export const ALL_GOOGLE_SCOPES: GoogleScope[] = [
  "calendar.read",
  "calendar.write",
  "drive.read",
  "drive.write",
  "gmail.read",
  "gmail.send",
];

function isValidScope(s: string): s is GoogleScope {
  return (ALL_GOOGLE_SCOPES as string[]).includes(s);
}

export class AgentUserScopesService {
  /**
   * Every grant for one agent in a single org, grouped by subject user so
   * the admin UI can render a per-user matrix in one shot.
   */
  async listByAgent(
    agentId: AgentId,
    organizationId: OrganizationId,
  ): Promise<Array<{ subjectUserId: UserId; scopes: GoogleScope[] }>> {
    await this.assertAgentInOrg(agentId, organizationId);
    const rows = await AgentUserScope.findAll({
      where: { agentId, organizationId },
      attributes: ["subjectUserId", "scope"],
      order: [["subjectUserId", "ASC"]],
    });
    const byUser = new Map<UserId, GoogleScope[]>();
    for (const r of rows) {
      const arr = byUser.get(r.subjectUserId) ?? [];
      arr.push(r.scope);
      byUser.set(r.subjectUserId, arr);
    }
    return [...byUser.entries()].map(([subjectUserId, scopes]) => ({
      subjectUserId,
      scopes,
    }));
  }

  async grant(params: {
    agentId: AgentId;
    subjectUserId: UserId;
    scope: string;
    grantedByUserId: UserId;
    organizationId: OrganizationId;
  }): Promise<AgentUserScopeAttributes> {
    if (!isValidScope(params.scope)) {
      throw Object.assign(new Error(`Unknown scope "${params.scope}".`), {
        status: 400,
      });
    }
    const [agent, subject] = await Promise.all([
      Agent.findByPk(params.agentId, { attributes: ["id", "organizationId"] }),
      User.findByPk(params.subjectUserId, {
        attributes: ["id", "organizationId", "externalSub", "authProvider"],
      }),
    ]);
    if (!agent || agent.organizationId !== params.organizationId) {
      throw Object.assign(new Error("Agent not found."), { status: 404 });
    }
    if (!subject || subject.organizationId !== params.organizationId) {
      throw Object.assign(new Error("Subject user not found."), { status: 404 });
    }
    if (!subject.externalSub || subject.authProvider !== "google") {
      throw Object.assign(
        new Error("Subject user has not authenticated with Google."),
        { status: 400 },
      );
    }

    const [row] = await AgentUserScope.findOrCreate({
      where: {
        agentId: params.agentId,
        subjectUserId: params.subjectUserId,
        scope: params.scope,
      },
      defaults: {
        agentId: params.agentId,
        subjectUserId: params.subjectUserId,
        organizationId: params.organizationId,
        scope: params.scope,
        grantedByUserId: params.grantedByUserId,
      },
    });

    this.broadcast(
      "agent_user_scope_granted",
      `Google "${params.scope}" access granted.`,
      {
        agentId: params.agentId,
        subjectUserId: params.subjectUserId,
        scope: params.scope,
      },
      params.grantedByUserId,
    );

    return row.get({ plain: true }) as AgentUserScopeAttributes;
  }

  async revoke(params: {
    agentId: AgentId;
    subjectUserId: UserId;
    scope: string;
    organizationId: OrganizationId;
    actorId: UserId;
  }): Promise<number> {
    if (!isValidScope(params.scope)) {
      throw Object.assign(new Error(`Unknown scope "${params.scope}".`), {
        status: 400,
      });
    }
    await this.assertAgentInOrg(params.agentId, params.organizationId);
    const n = await AgentUserScope.destroy({
      where: {
        agentId: params.agentId,
        subjectUserId: params.subjectUserId,
        scope: params.scope,
        organizationId: params.organizationId,
      },
    });
    if (n > 0) {
      this.broadcast(
        "agent_user_scope_revoked",
        `Google "${params.scope}" access revoked.`,
        {
          agentId: params.agentId,
          subjectUserId: params.subjectUserId,
          scope: params.scope,
        },
        params.actorId,
      );
    }
    return n;
  }

  private async assertAgentInOrg(
    agentId: AgentId,
    organizationId: OrganizationId,
  ): Promise<void> {
    const agent = await Agent.findOne({
      where: { id: agentId, organizationId },
      attributes: ["id"],
    });
    if (!agent) {
      throw Object.assign(new Error("Agent not found."), { status: 404 });
    }
  }

  private broadcast(
    type: string,
    message: string,
    data: Record<string, unknown>,
    actorId: UserId,
  ): void {
    try {
      getIO().emit("admin:change", { type, message, data, actorId });
    } catch (err) {
      logger.error("agentUserScopes broadcast failed", { error: String(err) });
    }
  }
}

/**
 * Companion helper for the admin "Google Permissions" UI — lists every user
 * in the org that has completed Google SSO (externalSub is set and
 * authProvider='google'). These are the only users that can legally be
 * subjects of a scope grant, since DWD impersonation needs their Workspace
 * email.
 */
export async function listGoogleAuthedUsers(organizationId: OrganizationId) {
  const users = await User.findAll({
    where: {
      organizationId,
      authProvider: "google",
      externalSub: { [Op.ne]: null },
    },
    attributes: ["id", "displayName", "userName", "externalSub", "lastLoginAt"],
    order: [["display_name", "ASC"]],
  });
  return users.map((u) => ({
    id: u.id,
    displayName: u.displayName,
    userName: u.userName,
    lastLoginAt: u.lastLoginAt,
  }));
}
