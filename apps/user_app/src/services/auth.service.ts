import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcrypt";
import {
  User,
  Role,
  Group,
  GroupMember,
  SingleChat,
  Agent,
  LLMModel,
  Vendor,
  Organization,
  sequelize,
} from "@scheduling-agent/database";
import { signToken } from "../middlewares/auth";
import { logger } from "../logger";
import { seedOrganizationAgents } from "./admin/orgAgentSeeder";
import {
  type UserId,
  type RegisterOrganizationInput,
} from "@scheduling-agent/types";
import {
  GoogleAuthService,
  signBootstrapTicket,
  verifyBootstrapTicket,
  checkDomainTxt,
  domainVerificationTxtValue,
  DOMAIN_VERIFICATION_TXT_PREFIX,
  type VerifiedGoogleIdentity,
} from "./google.service";

/**
 * Role assigned to the user who creates a new tenant via the onboarding
 * wizard. `super_admin` = maximum privilege *within their own org* — it is
 * NOT a cross-tenant bypass. Every query that filters by `organizationId`
 * keeps that filter for super_admins too; the role only affects
 * intra-tenant capabilities (edit every agent's core_instructions, change
 * other users' roles, etc.). Cross-tenant maintenance happens out-of-band
 * via direct DB access, not via this API.
 */
const SUPER_ADMIN_ROLE_ID = "00000000-0000-4000-c000-000000000003";
const WORKSPACES_ROOT = path.join(process.env.DATA_DIR || "/app/data", "workspaces");

function slugifyOrg(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "org"
  );
}

export class AuthService {
  private googleAuth = new GoogleAuthService();

  /**
   * Pre-registration Google sign-in — the admin proves Workspace ownership
   * before their org exists. We verify the id token against env-level client
   * ids only (org-scoped verification is impossible pre-org), reject if an
   * org is already registered for the `hd`, and return a short-lived signed
   * ticket the client carries through the rest of the wizard. The ticket is
   * redeemed during `registerOrganization` to create the SSO admin without
   * ever asking the user for a local username/password.
   */
  async bootstrapGoogleIdentity(idToken: string) {
    const identity = await this.googleAuth.verifyBootstrapIdToken(idToken);
    // The initial ticket is always `verifiedDomain: false`. The wizard must
    // redeem it at `/auth/google-verify-domain` (after publishing the TXT
    // record) to exchange it for a verified ticket before `/auth/register`.
    const ticket = signBootstrapTicket({
      sub: identity.sub,
      email: identity.email,
      hd: identity.hd,
      name: identity.name,
      verifiedDomain: false,
    });
    const txtValue = domainVerificationTxtValue(identity.hd, identity.sub);
    return {
      ticket,
      identity: {
        email: identity.email,
        name: identity.name,
        hd: identity.hd,
        picture: identity.picture,
      },
      // Surfaced to the wizard so it can tell the admin exactly what to
      // publish on their root domain. `name` is the record's DNS name
      // (root domain), `value` is the full string (prefix + token).
      txtRecord: {
        name: identity.hd,
        value: txtValue,
      },
    };
  }

  /**
   * DNS-based proof of domain ownership.
   *
   * Admin publishes `TXT sched-assist-verify=<token>` at the root of their
   * Workspace domain; we verify the (still-unverified) bootstrap ticket,
   * re-derive the expected token from its `(hd, sub)` claims, run a live
   * DNS lookup, and — on match — re-issue the ticket with `verifiedDomain`
   * flipped to true. The caller carries the new ticket into `/auth/register`.
   *
   * If the lookup fails (record missing, not yet propagated, etc.) we return
   * a 409 with the expected TXT value so the UI can re-display it.
   */
  async verifyGoogleDomain(ticket: string) {
    const claims = verifyBootstrapTicket(ticket);
    if (claims.verifiedDomain) {
      // Already verified — idempotent path. Just re-sign so the TTL is fresh.
      const refreshed = signBootstrapTicket({
        sub: claims.sub,
        email: claims.email,
        hd: claims.hd,
        name: claims.name,
        verifiedDomain: true,
      });
      return { ticket: refreshed, verified: true as const };
    }

    const expected = domainVerificationTxtValue(claims.hd, claims.sub);
    const ok = await checkDomainTxt(claims.hd, expected);
    if (!ok) {
      throw Object.assign(
        new Error(
          `No matching TXT record found on ${claims.hd} yet. DNS changes can take up to 30 minutes to propagate — try again shortly.`,
        ),
        {
          status: 409,
          details: {
            expectedPrefix: DOMAIN_VERIFICATION_TXT_PREFIX,
            expectedValue: expected,
            hd: claims.hd,
          },
        },
      );
    }

    const verified = signBootstrapTicket({
      sub: claims.sub,
      email: claims.email,
      hd: claims.hd,
      name: claims.name,
      verifiedDomain: true,
    });
    return { ticket: verified, verified: true as const };
  }

  async login(userName: string, password: string) {
    const user = await User.findOne({ where: { userName } });
    if (!user || !user.password)
      throw Object.assign(new Error("Invalid credentials."), { status: 401 });
    if (user.authProvider !== "local") {
      throw Object.assign(
        new Error(
          "This account is managed by SSO — sign in with your organization provider.",
        ),
        { status: 401 },
      );
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid)
      throw Object.assign(new Error("Invalid credentials."), { status: 401 });

    let roleName = "user";
    if (user.roleId) {
      const role = await Role.findByPk(user.roleId, { attributes: ["name"] });
      if (role) roleName = role.name;
    }

    const token = signToken({
      userId: user.id,
      displayName: user.displayName,
      role: roleName,
      organizationId: user.organizationId,
    });

    await this.ensureAgentSingleChats(user.id, user.organizationId);
    const conversations = await this.loadUserConversations(user.id, user.organizationId);

    // Snapshot BEFORE bumping — null means "welcome animation" on the client.
    const isFirstLogin = user.lastLoginAt === null;
    await user.update({ lastLoginAt: new Date() });

    const org = await Organization.findByPk(user.organizationId, {
      attributes: ["id", "name", "slug", "logo", "webSearchAgentId"],
    });

    return {
      token,
      isFirstLogin,
      user: {
        id: user.id,
        displayName: user.displayName,
        userIdentity: user.userIdentity,
        role: roleName,
      },
      organization: org
        ? {
            id: org.id,
            name: org.name,
            slug: org.slug,
            logo: org.logo,
            webSearchAgentId: org.webSearchAgentId,
          }
        : null,
      conversations,
    };
  }

  /**
   * Just-in-time Google Workspace SSO.
   *
   * Verifies the Google id token, resolves the tenant from its `hd` claim,
   * then either matches an existing SSO user (by provider + `sub`) or
   * provisions a fresh one in that tenant. Local-auth users that happen to
   * share the same email are left untouched — SSO always creates its own
   * record flagged with `auth_provider='google'`. Same JWT shape as the
   * password login so the client can treat both flows identically.
   */
  async loginWithGoogle(idToken: string) {
    const identity = await this.googleAuth.verifyIdToken(idToken);
    const user = await this.findOrProvisionGoogleUser(identity);

    let roleName = "user";
    if (user.roleId) {
      const role = await Role.findByPk(user.roleId, { attributes: ["name"] });
      if (role) roleName = role.name;
    }

    const token = signToken({
      userId: user.id,
      displayName: user.displayName,
      role: roleName,
      organizationId: user.organizationId,
    });

    await this.ensureAgentSingleChats(user.id, user.organizationId);
    const conversations = await this.loadUserConversations(
      user.id,
      user.organizationId,
    );

    // Snapshot BEFORE bumping — null covers JIT provisioning *and* any
    // pre-existing SSO row that hasn't signed in since this column landed.
    const isFirstLogin = user.lastLoginAt === null;
    await user.update({ lastLoginAt: new Date() });

    const org = identity.organization;
    return {
      token,
      isFirstLogin,
      user: {
        id: user.id,
        displayName: user.displayName,
        userIdentity: user.userIdentity,
        role: roleName,
      },
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        logo: org.logo,
        webSearchAgentId: org.webSearchAgentId,
      },
      conversations,
    };
  }

  /**
   * Finds the existing SSO user for this Google identity or creates one
   * inside the caller's resolved tenant. Matching order:
   *   1. `(auth_provider='google', external_sub=sub)` — stable across email renames.
   *   2. `(auth_provider='google', user_name=email)` scoped to this org —
   *      catches pre-existing SSO rows imported without a `sub` and backfills it.
   * A local-auth row with the same `user_name` means the tenant already uses
   * that handle for password auth; we reject rather than silently hijack it.
   */
  private async findOrProvisionGoogleUser(
    identity: VerifiedGoogleIdentity,
  ): Promise<User> {
    const org = identity.organization;
    const userName = identity.email;

    const bySub = await User.findOne({
      where: { authProvider: "google", externalSub: identity.sub },
    });
    if (bySub) {
      if (bySub.organizationId !== org.id) {
        throw Object.assign(
          new Error("This Google account is registered to a different tenant."),
          { status: 409 },
        );
      }
      // Opportunistically refresh display name/picture on each login so the
      // local mirror stays in sync with Workspace profile changes.
      if (identity.name && bySub.displayName !== identity.name) {
        await bySub.update({ displayName: identity.name });
      }
      return bySub;
    }

    const byNameInOrg = await User.findOne({
      where: { userName, organizationId: org.id },
    });
    if (byNameInOrg) {
      if (byNameInOrg.authProvider === "local") {
        throw Object.assign(
          new Error(
            "A local account with this email already exists. Ask an admin to migrate it to SSO.",
          ),
          { status: 409 },
        );
      }
      // google-provisioned but missing external_sub — backfill and reuse.
      await byNameInOrg.update({
        externalSub: identity.sub,
        displayName: identity.name ?? byNameInOrg.displayName,
      });
      return byNameInOrg;
    }

    // Fresh JIT provisioning. No role assigned — this is a regular member.
    // Admins still need to grant role/membership explicitly. lastLoginAt is
    // intentionally left null so the caller's check fires the welcome anim.
    return await User.create({
      userName,
      displayName: identity.name,
      organizationId: org.id,
      authProvider: "google",
      externalSub: identity.sub,
      password: null,
      roleId: null,
    });
  }

  /**
   * Creates a new tenant (organization) with:
   *  - admin user (local password OR Google SSO, depending on payload)
   *  - N primary agents
   *  - SingleChats for admin ↔ each agent
   * Returns a ready-to-use JWT (same shape as `login`).
   *
   * Exactly one of `data.admin` / `data.googleBootstrapTicket` must be set;
   * the zod `.refine` on the schema already enforces that.
   */
  async registerOrganization(data: RegisterOrganizationInput) {
    // Resolve the admin identity + org workspace domain from whichever auth
    // path the caller chose. We compute everything we need up front so the
    // transaction body below doesn't care which branch we're in.
    let adminSpec:
      | {
          kind: "password";
          userName: string;
          displayName: string;
          passwordHash: string;
        }
      | {
          kind: "google";
          userName: string;
          displayName: string;
          externalSub: string;
        };
    let googleWorkspaceDomain: string | null = null;

    if (data.googleBootstrapTicket) {
      const claims = verifyBootstrapTicket(data.googleBootstrapTicket);
      // The ticket must have cleared DNS TXT domain verification — a fresh
      // bootstrap ticket won't have this flag until the wizard redeems it at
      // `/auth/google-verify-domain`. Guards against skipping the proof-of-
      // ownership step by calling `/auth/register` directly with the
      // unverified ticket.
      if (!claims.verifiedDomain) {
        throw Object.assign(
          new Error(
            "Google domain ownership has not been verified. Complete DNS TXT verification before registering.",
          ),
          { status: 403 },
        );
      }
      // Race-safety re-check — the bootstrap pre-flight also rejects this,
      // but a second wizard tab could have raced past it.
      const existingOrg = await Organization.findOne({
        where: { googleWorkspaceDomain: claims.hd },
      });
      if (existingOrg) {
        throw Object.assign(
          new Error(
            `An organization already exists for ${claims.hd}. Sign in with Google from the login page instead.`,
          ),
          { status: 409 },
        );
      }
      const existingUser = await User.findOne({
        where: { authProvider: "google", externalSub: claims.sub },
      });
      if (existingUser) {
        throw Object.assign(
          new Error("This Google account is already registered with a tenant."),
          { status: 409 },
        );
      }
      adminSpec = {
        kind: "google",
        userName: claims.email,
        displayName: claims.name ?? claims.email,
        externalSub: claims.sub,
      };
      googleWorkspaceDomain = claims.hd;
    } else if (data.admin) {
      const parsedAdmin = {
        userName: data.admin.userName.toLowerCase(),
        displayName: data.admin.displayName.trim(),
        password: data.admin.password,
      };
      const existing = await User.findOne({ where: { userName: parsedAdmin.userName } });
      if (existing)
        throw Object.assign(new Error("Username is already taken."), { status: 409 });
      adminSpec = {
        kind: "password",
        userName: parsedAdmin.userName,
        displayName: parsedAdmin.displayName,
        passwordHash: await bcrypt.hash(parsedAdmin.password, 10),
      };
    } else {
      // Should be unreachable — the zod schema's refine guards this.
      throw Object.assign(
        new Error("Either admin credentials or a Google bootstrap ticket is required."),
        { status: 400 },
      );
    }

    const baseSlug = slugifyOrg(data.organization.name);

    const { org, adminUser, agents, epicOrchestratorId } = await sequelize.transaction(async (tx) => {
      // Ensure slug is unique
      let slug = baseSlug;
      for (let attempt = 0; attempt < 5; attempt++) {
        const clash = await Organization.findOne({ where: { slug }, transaction: tx });
        if (!clash) break;
        slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
      }

      const org = await Organization.create(
        {
          name: data.organization.name.trim(),
          slug,
          logo: data.organization.logo ?? null,
          // web_search_agent_id is set after the per-org agents are seeded
          // (the chosen web-search agent doesn't exist yet at this point).
          webSearchAgentId: null,
          // SSO path stamps the workspace domain so future Google sign-ins
          // from this domain auto-route to this org.
          googleWorkspaceDomain,
        },
        { transaction: tx },
      );

      const adminUser = await User.create(
        {
          userName: adminSpec.userName,
          displayName: adminSpec.displayName,
          password: adminSpec.kind === "password" ? adminSpec.passwordHash : null,
          authProvider: adminSpec.kind === "google" ? "google" : "local",
          externalSub: adminSpec.kind === "google" ? adminSpec.externalSub : null,
          roleId: SUPER_ADMIN_ROLE_ID,
          organizationId: org.id,
          // The onboarding wizard already plays the cinematic launch
          // animation. Stamp now so their next login doesn't replay it.
          lastLoginAt: new Date(),
        },
        { transaction: tx },
      );

      const agents = [];
      for (const a of data.agents) {
        const agent = await Agent.create(
          {
            type: "primary",
            definition: a.definition.trim(),
            description: a.description?.trim() || null,
            modelId: a.modelId ?? null,
            createdByUserId: adminUser.id,
            organizationId: org.id,
          },
          { transaction: tx },
        );
        agents.push(agent);
      }

      for (const agent of agents) {
        await SingleChat.create(
          {
            userId: adminUser.id,
            agentId: agent.id,
            title: agent.definition?.trim() || "Agent Chat",
          },
          { transaction: tx },
        );
      }

      // Every org gets its OWN epic orchestrator + web-search agents (Gemini
      // and Tavily). Sharing them across orgs would mix episodic memory,
      // agent notes, and workspace folders across tenants.
      const seeded = await seedOrganizationAgents({
        organizationId: org.id,
        actorId: adminUser.id,
        webSearchChoice: data.webSearchChoice ?? "gemini",
        transaction: tx,
      });

      await org.update(
        { webSearchAgentId: seeded.activeWebSearchAgentId },
        { transaction: tx },
      );

      return {
        org,
        adminUser,
        agents,
        epicOrchestratorId: seeded.epicOrchestratorId,
      };
    });

    // Primary agents get a persistent workspace folder. System agents never
    // do — they write into their caller's workspace when delegated to.
    // Includes the user-defined primary agents plus the epic orchestrator
    // seeded for this org.
    const epicOrchestrator = await Agent.findByPk(epicOrchestratorId);
    const primaryAgentsNeedingWorkspace = [
      ...agents,
      ...(epicOrchestrator ? [epicOrchestrator] : []),
    ];
    for (const agent of primaryAgentsNeedingWorkspace) {
      const workspacePath = path.join(WORKSPACES_ROOT, agent.definition || agent.id);
      try {
        fs.mkdirSync(workspacePath, { recursive: true });
        await agent.update({ workspacePath });
      } catch (err) {
        logger.error("Failed to create workspace for agent", { agentId: agent.id, error: String(err) });
      }
    }

    const token = signToken({
      userId: adminUser.id,
      displayName: adminUser.displayName,
      role: "super_admin",
      organizationId: org.id,
    });

    const conversations = await this.loadUserConversations(adminUser.id, org.id);

    return {
      token,
      user: {
        id: adminUser.id,
        displayName: adminUser.displayName,
        userIdentity: adminUser.userIdentity,
        role: "super_admin",
      },
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        logo: org.logo,
        webSearchAgentId: org.webSearchAgentId,
      },
      conversations,
    };
  }

  async getMe(userId: UserId) {
    const user = await User.findByPk(userId, {
      attributes: ["id", "displayName", "userIdentity", "roleId", "organizationId"],
    });
    if (!user)
      throw Object.assign(new Error("User not found."), { status: 404 });

    let roleName = "user";
    if (user.roleId) {
      const role = await Role.findByPk(user.roleId, { attributes: ["name"] });
      if (role) roleName = role.name;
    }

    const org = await Organization.findByPk(user.organizationId, {
      attributes: ["id", "name", "slug", "logo", "webSearchAgentId"],
    });

    await this.ensureAgentSingleChats(user.id, user.organizationId);
    const conversations = await this.loadUserConversations(user.id, user.organizationId);

    return {
      id: user.id,
      displayName: user.displayName,
      userIdentity: user.userIdentity,
      role: roleName,
      organization: org
        ? {
            id: org.id,
            name: org.name,
            slug: org.slug,
            logo: org.logo,
            webSearchAgentId: org.webSearchAgentId,
          }
        : null,
      conversations,
    };
  }

  /**
   * Ensures a `single_chats` row exists for every primary agent in this user's
   * organization. System agents are internal-only.
   */
  private async ensureAgentSingleChats(userId: UserId, organizationId: string): Promise<void> {
    const agents = await Agent.findAll({
      where: { type: "primary", organizationId },
      attributes: ["id", "definition"],
    });
    for (const agent of agents) {
      await SingleChat.findOrCreate({
        where: { userId, agentId: agent.id },
        defaults: {
          userId,
          agentId: agent.id,
          title: agent.definition?.trim() || "Agent Chat",
        },
      });
    }
  }

  async loadUserConversations(userId: UserId, organizationId: string) {
    const memberships = await GroupMember.findAll({
      where: { userId },
      attributes: ["groupId"],
    });
    const groupIds = memberships.map((m) => m.groupId);

    let groups: any[] = [];
    if (groupIds.length > 0) {
      const groupRows = await Group.findAll({
        where: { id: groupIds },
        attributes: ["id", "name", "agentId"],
        order: [["name", "ASC"]],
      });
      groups = await Promise.all(
        groupRows.map(async (g) => {
          const agent = await Agent.findByPk(g.agentId, {
            attributes: ["definition", "modelId", "organizationId"],
          });
          return {
            id: g.id,
            name: g.name,
            agentId: g.agentId,
            agentDefinition: agent?.definition ?? null,
            model: await this.resolveModelInfo(agent?.modelId ?? null),
          };
        }),
      );
    }

    // Only return SingleChats for primary agents in the caller's org
    const primaryAgentIds = (
      await Agent.findAll({
        where: { type: "primary", organizationId },
        attributes: ["id"],
      })
    ).map((a) => a.id);

    const singleChatRows = primaryAgentIds.length === 0 ? [] : await SingleChat.findAll({
      where: { userId, agentId: primaryAgentIds },
      attributes: ["id", "agentId", "title"],
      order: [["created_at", "DESC"]],
    });
    const singleChats = await Promise.all(
      singleChatRows.map(async (sc) => {
        const agent = await Agent.findByPk(sc.agentId, {
          attributes: ["modelId"],
        });
        return {
          id: sc.id,
          agentId: sc.agentId,
          title: sc.title,
          model: await this.resolveModelInfo(agent?.modelId ?? null),
        };
      }),
    );

    return { groups, singleChats };
  }

  private async resolveModelInfo(modelId: string | null) {
    if (!modelId) return null;
    const model = await LLMModel.findByPk(modelId, {
      attributes: ["id", "name", "slug", "vendorId"],
    });
    if (!model) return null;
    const vendor = await Vendor.findByPk(model.vendorId, {
      attributes: ["id", "name", "slug"],
    });
    return {
      id: model.id,
      name: model.name,
      slug: model.slug,
      vendor: vendor
        ? { id: vendor.id, name: vendor.name, slug: vendor.slug }
        : null,
    };
  }
}
