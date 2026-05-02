import fs from "node:fs";
import path from "node:path";
import {
  Agent,
  SingleChat,
  GroupMember,
  Group,
  User,
  AgentAvailableMcpServer,
  AgentAvailableSkill,
  AgentAvailableTool,
  Skill,
  Tool,
  LLMModel,
  Vendor,
  sequelize,
} from "@scheduling-agent/database";
import { Op, QueryTypes } from "sequelize";
import { getIO } from "../../sockets/server/socketServer";
import { logger } from "../../logger";
import {
  AUTO_ASSIGNED_SKILL_SLUGS,
  SHARED_SYSTEM_AGENT_SLUG_SET,
  type UserId,
} from "@scheduling-agent/types";

const WORKSPACES_ROOT = path.join(process.env.DATA_DIR || "/app/data", "workspaces");

export class AgentsService {
  async getAll(callerId: UserId, callerRole: string, organizationId: string) {
    // Every role — including super_admin — is scoped to its own org. The
    // super_admin role is a tenant-internal elevation, not a platform bypass.
    const agents = await Agent.findAll({
      where: { organizationId },
      attributes: [
        "id",
        "type",
        "slug",
        "definition",
        "agentName",
        "description",
        "coreInstructions",
        "characteristics",
        "createdByUserId",
        "modelId",
        "isLocked",
        "organizationId",
        "owningPrimaryAgentId",
        "createdAt",
      ],
      order: [["created_at", "DESC"]],
    });

    const countRows = await sequelize.query<{ agentId: string; cnt: string }>(
      `SELECT agent_id AS "agentId", COUNT(*)::int AS cnt FROM groups GROUP BY agent_id`,
      { type: QueryTypes.SELECT },
    );
    const groupCountByAgent: Record<string, number> = {};
    for (const r of countRows) {
      groupCountByAgent[r.agentId] = Number(r.cnt);
    }

    const editableIds = await this.getEditableAgentIds(callerId, callerRole, organizationId);

    // Fetch ALL MCP server assignments (including inactive) for all agents
    const mcpLinks = await AgentAvailableMcpServer.findAll({
      attributes: ["agentId", "mcpServerId", "active"],
    });
    const mcpServerIdsByAgent: Record<string, number[]> = {};
    const mcpLinksByAgent: Record<string, { mcpServerId: number; active: boolean }[]> = {};
    for (const link of mcpLinks) {
      (mcpLinksByAgent[link.agentId] ??= []).push({ mcpServerId: link.mcpServerId, active: link.active });
      if (link.active) {
        (mcpServerIdsByAgent[link.agentId] ??= []).push(link.mcpServerId);
      }
    }

    // Resolve auto-assigned skill ids so they are stripped from admin views
    // (tools + skill_text for these are always injected at runtime).
    const autoSkillRows = await Skill.findAll({
      attributes: ["id"],
      where: { slug: { [Op.in]: [...AUTO_ASSIGNED_SKILL_SLUGS] } },
    });
    const autoSkillIds = new Set(autoSkillRows.map((s) => s.id));

    // Fetch ALL skill assignments (including inactive) for all agents
    const skillLinks = await AgentAvailableSkill.findAll({
      attributes: ["agentId", "skillId", "active"],
    });
    const skillIdsByAgent: Record<string, number[]> = {};
    const skillLinksByAgent: Record<string, { skillId: number; active: boolean }[]> = {};
    for (const link of skillLinks) {
      if (autoSkillIds.has(link.skillId)) continue;
      (skillLinksByAgent[link.agentId] ??= []).push({ skillId: link.skillId, active: link.active });
      if (link.active) {
        (skillIdsByAgent[link.agentId] ??= []).push(link.skillId);
      }
    }

    // Fetch ALL tool assignments (including inactive) for all agents
    const toolLinks = await AgentAvailableTool.findAll({
      attributes: ["agentId", "toolId", "active"],
    });
    const toolIdsByAgent: Record<string, number[]> = {};
    const toolLinksByAgent: Record<string, { toolId: number; active: boolean }[]> = {};
    for (const link of toolLinks) {
      (toolLinksByAgent[link.agentId] ??= []).push({ toolId: link.toolId, active: link.active });
      if (link.active) {
        (toolIdsByAgent[link.agentId] ??= []).push(link.toolId);
      }
    }

    return agents.map((a) => ({
      ...a.toJSON(),
      groupCount: groupCountByAgent[a.id] ?? 0,
      editable: editableIds.has(a.id) && !a.isLocked,
      isLocked: a.isLocked,
      mcpServerIds: mcpServerIdsByAgent[a.id] ?? [],
      skillIds: skillIdsByAgent[a.id] ?? [],
      toolIds: toolIdsByAgent[a.id] ?? [],
      mcpServerLinks: mcpLinksByAgent[a.id] ?? [],
      skillLinks: skillLinksByAgent[a.id] ?? [],
      toolLinks: toolLinksByAgent[a.id] ?? [],
    }));
  }

  async create(
    definition: string,
    coreInstructions?: string,
    characteristics?: Record<string, unknown> | null,
    actorId?: UserId,
    mcpServerIds?: number[],
    modelId?: string | null,
    skillIds?: number[],
    agentName?: string | null,
    agentType?:
      | "primary"
      | "system"
      | "external"
      | "application"
      | "claude_sub_agent",
    toolIds?: number[],
    description?: string | null,
    organizationId?: string,
  ) {
    const normalizedAgentName =
      agentName !== undefined && agentName !== null && String(agentName).trim() !== ""
        ? String(agentName).trim()
        : null;
    if (modelId) await this.rejectGoogleModel(modelId);

    if (!organizationId) {
      throw Object.assign(new Error("organizationId is required to create an agent."), { status: 400 });
    }

    const resolvedType = agentType ?? "primary";

    const agent = await Agent.create({
      type: resolvedType,
      definition,
      agentName: normalizedAgentName,
      description: description?.trim() || null,
      coreInstructions: coreInstructions ?? null,
      characteristics: characteristics ?? null,
      createdByUserId: actorId ?? null,
      modelId: modelId ?? null,
      organizationId,
    });

    // System agents do not get their own workspace — when they execute a
    // delegation they write into the caller's workspace folder instead.
    // claude_sub_agent rows likewise share the parent primary's workspace
    // through the SDK runner's `cwd` plumbing (slice 17), so they don't
    // need a per-row directory either.
    if (resolvedType !== "system" && resolvedType !== "claude_sub_agent") {
      const workspaceFolderName = (agent.definition || agent.id).replace(/\s+/g, "_");
      const workspacePath = path.join(WORKSPACES_ROOT, workspaceFolderName);
      try {
        fs.mkdirSync(workspacePath, { recursive: true });
        await agent.update({ workspacePath });
      } catch (err) {
        logger.error("Failed to create workspace for agent", { agentId: agent.id, error: String(err) });
      }
    }

    // Link MCP servers to the agent
    if (mcpServerIds && mcpServerIds.length > 0) {
      await AgentAvailableMcpServer.bulkCreate(
        mcpServerIds.map((mcpServerId) => ({
          agentId: agent.id,
          mcpServerId,
          active: true,
        })),
      );
    }

    if (skillIds && skillIds.length > 0) {
      await AgentAvailableSkill.bulkCreate(
        skillIds.map((skillId) => ({
          agentId: agent.id,
          skillId,
          active: true,
        })),
      );
    }

    // Link tools to the agent. If none specified, assign ALL tools by default.
    if (toolIds && toolIds.length > 0) {
      await AgentAvailableTool.bulkCreate(
        toolIds.map((toolId) => ({
          agentId: agent.id,
          toolId,
          active: true,
        })),
      );
    } else {
      const allTools = await Tool.findAll({ attributes: ["id"] });
      if (allTools.length > 0) {
        await AgentAvailableTool.bulkCreate(
          allTools.map((t) => ({
            agentId: agent.id,
            toolId: t.id,
            active: true,
          })),
        );
      }
    }

    // Eagerly create a SingleChat for every user — primary agents only
    // (system agents are invoked by other agents, not directly by users)
    if ((agentType ?? "primary") === "primary") try {
      let modelInfo: { id: string; name: string; slug: string; vendor: { id: string; name: string; slug: string } | null } | null = null;
      if (agent.modelId) {
        const m = await LLMModel.findByPk(agent.modelId, { attributes: ["id", "name", "slug", "vendorId"] });
        if (m) {
          const v = await Vendor.findByPk(m.vendorId, { attributes: ["id", "name", "slug"] });
          modelInfo = { id: m.id, name: m.name, slug: m.slug, vendor: v ? { id: v.id, name: v.name, slug: v.slug } : null };
        }
      }

      const allUsers = await User.findAll({
        where: { organizationId },
        attributes: ["id"],
      });
      for (const u of allUsers) {
        const [sc] = await SingleChat.findOrCreate({
          where: { userId: u.id, agentId: agent.id },
          defaults: {
            userId: u.id,
            agentId: agent.id,
            title: agent.definition?.trim() || "Agent Chat",
          },
        });
        getIO().to(`user:${u.id}`).emit("conversations:updated", {
          action: "single_chat_added",
          singleChat: {
            id: sc.id,
            agentId: agent.id,
            title: sc.title,
            model: modelInfo,
          },
        });
      }
    } catch (err) {
      logger.error("Failed to create single chats for new agent", { agentId: agent.id, error: String(err) });
    }

    this.broadcast(
      "agent_created",
      `Agent "${agent.definition || "Unnamed"}" created`,
      { agent },
      actorId,
    );
    return agent;
  }

  async update(
    agentId: string,
    callerId: UserId,
    callerRole: string,
    callerOrgId: string,
    data: {
      definition?: string;
      agentName?: string | null;
      description?: string | null;
      coreInstructions?: string;
      characteristics?: Record<string, unknown> | null;
      mcpServerIds?: number[];
      mcpServerLinks?: { mcpServerId: number; active: boolean }[];
      modelId?: string | null;
      skillIds?: number[];
      skillLinks?: { skillId: number; active: boolean }[];
      toolIds?: number[];
      toolLinks?: { toolId: number; active: boolean }[];
      /**
       * Owner of a system agent. Pass `null` to mark it shared (org-wide,
       * the legacy default) or the UUID of a primary agent in the same org
       * to make it private to that primary. Only valid for system agents.
       * Omit the field entirely to leave ownership unchanged.
       */
      owningPrimaryAgentId?: string | null;
    },
  ) {
    // Scope the lookup by org so cross-tenant reads are impossible — no role
    // (including super_admin) can reach agents in another org through this API.
    const agent = await Agent.findOne({
      where: { id: agentId, organizationId: callerOrgId },
    });
    if (!agent)
      throw Object.assign(new Error("Agent not found."), { status: 404 });

    if (agent.isLocked) {
      throw Object.assign(
        new Error("This agent is locked and cannot be modified."),
        { status: 403 },
      );
    }

    const editableIds = await this.getEditableAgentIds(callerId, callerRole, callerOrgId);
    if (!editableIds.has(agent.id)) {
      throw Object.assign(
        new Error("You do not have permission to edit this agent."),
        { status: 403 },
      );
    }

    // Admins can only update coreInstructions for agents they created; super_admin can always
    const canEditCoreInstructions =
      callerRole === "super_admin" || agent.createdByUserId === callerId;

    const patch: Record<string, any> = {};
    if (data.definition !== undefined) patch.definition = data.definition;
    if (data.description !== undefined)
      patch.description = data.description?.trim() || null;
    if (data.agentName !== undefined) {
      patch.agentName =
        data.agentName === null || String(data.agentName).trim() === ""
          ? null
          : String(data.agentName).trim();
    }
    if (data.coreInstructions !== undefined && canEditCoreInstructions)
      patch.coreInstructions = data.coreInstructions;
    if (data.characteristics !== undefined)
      patch.characteristics = data.characteristics;
    if (data.modelId !== undefined) {
      if (data.modelId) await this.rejectGoogleModel(data.modelId);
      patch.modelId = data.modelId;
    }

    // Ownership change. Mirrors the DB CHECK constraint (system OR
    // claude_sub_agent only) and adds explicit cross-org + vendor guards.
    if (data.owningPrimaryAgentId !== undefined) {
      if (data.owningPrimaryAgentId !== null) {
        if (agent.type !== "system" && agent.type !== "claude_sub_agent") {
          throw Object.assign(
            new Error(
              "Only system or claude_sub_agent agents can have an owning primary agent.",
            ),
            { status: 400 },
          );
        }
        // Some system agents are shared by design (web search, Google
        // Workspace) — every primary in the org must be able to delegate to
        // them, so they can't be locked to a single owner. The admin UI
        // disables the select for these too; this is the server-side
        // backstop in case the request comes in via API or an out-of-date UI.
        if (
          agent.type === "system" &&
          agent.slug &&
          SHARED_SYSTEM_AGENT_SLUG_SET.has(agent.slug)
        ) {
          throw Object.assign(
            new Error(
              `System agent "${agent.slug}" is shared org-wide by design and cannot be assigned to a single primary agent.`,
            ),
            { status: 400 },
          );
        }
        const owner = await Agent.findOne({
          where: {
            id: data.owningPrimaryAgentId,
            type: "primary",
            organizationId: callerOrgId,
          },
        });
        if (!owner) {
          throw Object.assign(
            new Error(
              "Owning primary agent not found in this organization, or is not a primary agent.",
            ),
            { status: 400 },
          );
        }
        // claude_sub_agent ownership is only meaningful when the primary
        // runs on an Anthropic-vendor model — the Claude Agent SDK is the
        // only runtime that can actually invoke it via `agents:`. Reject
        // attachment to a non-Anthropic primary at the server boundary;
        // the admin UI also filters its dropdown but this is the backstop.
        if (agent.type === "claude_sub_agent") {
          const ownerOnAnthropic = await this.isAgentOnAnthropic(owner);
          if (!ownerOnAnthropic) {
            throw Object.assign(
              new Error(
                "claude_sub_agent can only be assigned to a primary agent running on an Anthropic-vendor model.",
              ),
              { status: 400 },
            );
          }
        }
      }
      patch.owningPrimaryAgentId = data.owningPrimaryAgentId;
    }

    // Snapshot whether the primary was on Anthropic BEFORE applying the
    // patch — we need to know whether this update is the moment of the
    // off-ramp. Only relevant for primary agents whose modelId is being
    // changed; cheap no-op otherwise.
    const wasPrimaryOnAnthropicBefore =
      agent.type === "primary" && data.modelId !== undefined
        ? await this.isAgentOnAnthropic(agent)
        : false;

    await agent.update(patch);

    // Cascade-null `claude_sub_agent` assignments off this primary if it
    // just transitioned from Anthropic to a different vendor (slice 17).
    // We don't unconditionally re-run on every update — the lookup is
    // gated on `wasPrimaryOnAnthropicBefore` so non-Anthropic primaries
    // and non-model-touching updates skip the work entirely.
    if (
      wasPrimaryOnAnthropicBefore &&
      agent.type === "primary" &&
      data.modelId !== undefined
    ) {
      const isOnAnthropicNow = await this.isAgentOnAnthropic(agent);
      if (!isOnAnthropicNow) {
        const detached = await this.detachClaudeSubAgentsFromPrimary(agent.id);
        if (detached.length > 0) {
          logger.info(
            "Detached claude_sub_agents from primary that left Anthropic",
            { primaryId: agent.id, detachedAgentIds: detached },
          );
          this.broadcast(
            "claude_sub_agent_detached",
            `Detached ${detached.length} sub-agent(s) — primary "${agent.definition || agent.id}" left the Anthropic vendor.`,
            { primaryId: agent.id, detachedAgentIds: detached },
            callerId,
          );
        }
      }
    }

    // Sync MCP server assignments if provided (new format takes precedence)
    if (data.mcpServerLinks !== undefined) {
      await AgentAvailableMcpServer.destroy({ where: { agentId: agent.id } });
      if (data.mcpServerLinks.length > 0) {
        await AgentAvailableMcpServer.bulkCreate(
          data.mcpServerLinks.map((link) => ({
            agentId: agent.id,
            mcpServerId: link.mcpServerId,
            active: link.active,
          })),
        );
      }
    } else if (data.mcpServerIds !== undefined) {
      await AgentAvailableMcpServer.destroy({ where: { agentId: agent.id } });
      if (data.mcpServerIds.length > 0) {
        await AgentAvailableMcpServer.bulkCreate(
          data.mcpServerIds.map((mcpServerId) => ({
            agentId: agent.id,
            mcpServerId,
            active: true,
          })),
        );
      }
    }

    // Sync skill assignments if provided (new format takes precedence)
    if (data.skillLinks !== undefined) {
      // Preserve locked skills — they must remain assigned and active
      const currentLinks = await AgentAvailableSkill.findAll({
        where: { agentId: agent.id },
        attributes: ["skillId"],
      });
      const lockedSkills = currentLinks.length > 0
        ? await Skill.findAll({ where: { id: currentLinks.map((l) => l.skillId), locked: true }, attributes: ["id"] })
        : [];
      const lockedIds = new Set(lockedSkills.map((s) => s.id));

      // Non-locked: use what the client sent; locked: force active=true
      const finalLinks: { skillId: number; active: boolean }[] = [];
      const seen = new Set<number>();
      for (const link of data.skillLinks) {
        if (seen.has(link.skillId)) continue;
        seen.add(link.skillId);
        finalLinks.push(lockedIds.has(link.skillId) ? { skillId: link.skillId, active: true } : link);
      }
      // Add any locked skills that the client omitted
      for (const lockedId of lockedIds) {
        if (!seen.has(lockedId)) {
          finalLinks.push({ skillId: lockedId, active: true });
        }
      }

      await AgentAvailableSkill.destroy({ where: { agentId: agent.id } });
      if (finalLinks.length > 0) {
        await AgentAvailableSkill.bulkCreate(
          finalLinks.map((link) => ({
            agentId: agent.id,
            skillId: link.skillId,
            active: link.active,
          })),
        );
      }
    } else if (data.skillIds !== undefined) {
      // Legacy format — all active
      const currentLinks = await AgentAvailableSkill.findAll({
        where: { agentId: agent.id, active: true },
        attributes: ["skillId"],
      });
      const currentIds = currentLinks.map((l) => l.skillId);
      const lockedSkills = await Skill.findAll({
        where: { id: currentIds, locked: true },
        attributes: ["id"],
      });
      const lockedIds = new Set(lockedSkills.map((s) => s.id));
      const finalIds = Array.from(new Set([...data.skillIds, ...lockedIds]));

      await AgentAvailableSkill.destroy({ where: { agentId: agent.id } });
      if (finalIds.length > 0) {
        await AgentAvailableSkill.bulkCreate(
          finalIds.map((skillId) => ({
            agentId: agent.id,
            skillId,
            active: true,
          })),
        );
      }
    }

    // Sync tool assignments if provided (new format takes precedence)
    if (data.toolLinks !== undefined) {
      await AgentAvailableTool.destroy({ where: { agentId: agent.id } });
      if (data.toolLinks.length > 0) {
        await AgentAvailableTool.bulkCreate(
          data.toolLinks.map((link) => ({
            agentId: agent.id,
            toolId: link.toolId,
            active: link.active,
          })),
        );
      }
    } else if (data.toolIds !== undefined) {
      await AgentAvailableTool.destroy({ where: { agentId: agent.id } });
      if (data.toolIds.length > 0) {
        await AgentAvailableTool.bulkCreate(
          data.toolIds.map((toolId) => ({
            agentId: agent.id,
            toolId,
            active: true,
          })),
        );
      }
    }

    // Notify users who interact with this agent when the model changes
    if (data.modelId !== undefined) {
      try {
        await this.notifyAgentModelChanged(agent.id, agent.modelId);
      } catch (err) {
        logger.error("Failed to notify users of agent model change", {
          agentId: agent.id,
          error: String(err),
        });
      }
    }

    this.broadcast(
      "agent_updated",
      `Agent "${agent.definition || "Unnamed"}" updated`,
      { agent },
      callerId,
    );
    return agent;
  }

  async getEditableAgentIds(
    userId: UserId,
    role: string,
    organizationId: string,
  ): Promise<Set<string>> {
    // super_admin gets every agent *inside their own org* — the bypass is
    // role-elevation within a tenant, not a cross-tenant platform privilege.
    // Cross-org maintenance happens out-of-band (direct DB), not via this API.
    if (role === "super_admin") {
      const allAgents = await Agent.findAll({
        where: { organizationId },
        attributes: ["id"],
      });
      return new Set(allAgents.map((a) => a.id));
    }

    const ids = new Set<string>();

    const userChats = await SingleChat.findAll({
      where: { userId },
      attributes: ["agentId"],
    });
    for (const sc of userChats) {
      ids.add(sc.agentId);
    }

    const memberships = await GroupMember.findAll({
      where: { userId },
      attributes: ["groupId"],
    });
    if (memberships.length > 0) {
      const groupIds = memberships.map((m) => m.groupId);
      const groups = await Group.findAll({
        where: { id: groupIds },
        attributes: ["agentId"],
      });
      for (const g of groups) {
        ids.add(g.agentId);
      }
    }

    return ids;
  }

  /** Reject models from the Google vendor — Gemini is not a supported provider. */
  private async rejectGoogleModel(modelId: string) {
    const model = await LLMModel.findByPk(modelId, { attributes: ["vendorId"] });
    if (!model) return;
    const vendor = await Vendor.findByPk(model.vendorId, { attributes: ["slug"] });
    if (vendor?.slug === "google") {
      throw Object.assign(new Error("Google (Gemini) models are not supported."), { status: 400 });
    }
  }

  /**
   * Returns true when the agent's currently assigned model belongs to the
   * Anthropic vendor. Used to gate `claude_sub_agent` ownership — the
   * Claude Agent SDK only fires for Anthropic-vendor primaries, so it
   * makes no sense to attach a sub-agent to a primary that runs on
   * OpenAI/Google. Falls back to `false` when modelId is null (no model
   * configured yet).
   */
  private async isAgentOnAnthropic(agent: Agent): Promise<boolean> {
    if (!agent.modelId) return false;
    const model = await LLMModel.findByPk(agent.modelId, {
      attributes: ["vendorId"],
    });
    if (!model) return false;
    const vendor = await Vendor.findByPk(model.vendorId, {
      attributes: ["slug"],
    });
    return vendor?.slug === "anthropic";
  }

  /**
   * Detaches every `claude_sub_agent` currently owned by this primary —
   * sets `owning_primary_agent_id = NULL`, returning the agents to the
   * "available for assignment" pool. Called from `update()` whenever a
   * primary's modelId moves off the Anthropic vendor (slice 17).
   *
   * Returns the list of detached agent ids so the caller can broadcast a
   * single change event for the UI.
   */
  private async detachClaudeSubAgentsFromPrimary(
    primaryId: string,
  ): Promise<string[]> {
    const owned = await Agent.findAll({
      where: { type: "claude_sub_agent", owningPrimaryAgentId: primaryId },
      attributes: ["id"],
    });
    if (owned.length === 0) return [];
    await Agent.update(
      { owningPrimaryAgentId: null },
      {
        where: { type: "claude_sub_agent", owningPrimaryAgentId: primaryId },
      },
    );
    return owned.map((a) => a.id);
  }

  /**
   * Notifies all users who have a SingleChat with this agent or are in a group
   * with this agent that the agent's model has changed.
   */
  private async notifyAgentModelChanged(agentId: string, modelId: string | null) {
    // Resolve model info for the notification payload
    let modelInfo: { id: string; name: string; slug: string; vendor: { id: string; name: string; slug: string } | null } | null = null;
    if (modelId) {
      const m = await LLMModel.findByPk(modelId, { attributes: ["id", "name", "slug", "vendorId"] });
      if (m) {
        const v = await Vendor.findByPk(m.vendorId, { attributes: ["id", "name", "slug"] });
        modelInfo = { id: m.id, name: m.name, slug: m.slug, vendor: v ? { id: v.id, name: v.name, slug: v.slug } : null };
      }
    }

    // Find all user IDs with a SingleChat for this agent
    const singleChats = await SingleChat.findAll({
      where: { agentId },
      attributes: ["userId"],
    });
    const userIds = new Set<number>(singleChats.map((sc) => sc.userId));

    // Find all user IDs in groups that use this agent
    const groups = await Group.findAll({
      where: { agentId },
      attributes: ["id"],
    });
    if (groups.length > 0) {
      const groupIds = groups.map((g) => g.id);
      const members = await GroupMember.findAll({
        where: { groupId: { [Op.in]: groupIds } },
        attributes: ["userId"],
      });
      for (const m of members) {
        userIds.add(m.userId);
      }
    }

    const io = getIO();
    for (const userId of userIds) {
      io.to(`user:${userId}`).emit("conversations:updated", {
        action: "agent_model_changed",
        agentId,
        model: modelInfo,
      });
    }

    logger.info("Notified users of agent model change", {
      agentId,
      modelSlug: modelInfo?.slug ?? null,
      userCount: userIds.size,
    });
  }

  private broadcast(
    type: string,
    message: string,
    data: Record<string, unknown>,
    actorId?: UserId,
  ) {
    try {
      getIO().emit("admin:change", { type, message, data, actorId });
    } catch (err) {
      logger.error("broadcastAdminChange error", { error: String(err) });
    }
  }
}
