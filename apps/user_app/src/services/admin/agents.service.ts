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
  Skill,
  LLMModel,
  Vendor,
  sequelize,
} from "@scheduling-agent/database";
import { Op, QueryTypes } from "sequelize";
import { getIO } from "../../sockets/server/socketServer";
import { logger } from "../../logger";
import type { UserId } from "@scheduling-agent/types";

const WORKSPACES_ROOT = path.join(process.env.DATA_DIR || "/app/data", "workspaces");

export class AgentsService {
  async getAll(callerId: UserId, callerRole: string) {
    const agents = await Agent.findAll({
      attributes: [
        "id",
        "type",
        "definition",
        "agentName",
        "coreInstructions",
        "characteristics",
        "createdByUserId",
        "modelId",
        "isLocked",
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

    const editableIds = await this.getEditableAgentIds(callerId, callerRole);

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

    // Fetch ALL skill assignments (including inactive) for all agents
    const skillLinks = await AgentAvailableSkill.findAll({
      attributes: ["agentId", "skillId", "active"],
    });
    const skillIdsByAgent: Record<string, number[]> = {};
    const skillLinksByAgent: Record<string, { skillId: number; active: boolean }[]> = {};
    for (const link of skillLinks) {
      (skillLinksByAgent[link.agentId] ??= []).push({ skillId: link.skillId, active: link.active });
      if (link.active) {
        (skillIdsByAgent[link.agentId] ??= []).push(link.skillId);
      }
    }

    return agents.map((a) => ({
      ...a.toJSON(),
      groupCount: groupCountByAgent[a.id] ?? 0,
      editable: editableIds.has(a.id) && !a.isLocked,
      isLocked: a.isLocked,
      mcpServerIds: mcpServerIdsByAgent[a.id] ?? [],
      skillIds: skillIdsByAgent[a.id] ?? [],
      mcpServerLinks: mcpLinksByAgent[a.id] ?? [],
      skillLinks: skillLinksByAgent[a.id] ?? [],
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
    agentType?: "primary" | "system",
  ) {
    const normalizedAgentName =
      agentName !== undefined && agentName !== null && String(agentName).trim() !== ""
        ? String(agentName).trim()
        : null;
    if (modelId) await this.rejectGoogleModel(modelId);

    const agent = await Agent.create({
      type: agentType ?? "primary",
      definition,
      agentName: normalizedAgentName,
      coreInstructions: coreInstructions ?? null,
      characteristics: characteristics ?? null,
      createdByUserId: actorId ?? null,
      modelId: modelId ?? null,
    });

    // Create persistent workspace folder for this agent (using definition as folder name)
    const workspacePath = path.join(WORKSPACES_ROOT, agent.definition || agent.id);
    try {
      fs.mkdirSync(workspacePath, { recursive: true });
      await agent.update({ workspacePath });
    } catch (err) {
      logger.error("Failed to create workspace for agent", { agentId: agent.id, error: String(err) });
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

      const allUsers = await User.findAll({ attributes: ["id"] });
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
    data: {
      definition?: string;
      agentName?: string | null;
      coreInstructions?: string;
      characteristics?: Record<string, unknown> | null;
      mcpServerIds?: number[];
      mcpServerLinks?: { mcpServerId: number; active: boolean }[];
      modelId?: string | null;
      skillIds?: number[];
      skillLinks?: { skillId: number; active: boolean }[];
    },
  ) {
    const agent = await Agent.findByPk(agentId);
    if (!agent)
      throw Object.assign(new Error("Agent not found."), { status: 404 });

    if (agent.isLocked) {
      throw Object.assign(
        new Error("This agent is locked and cannot be modified."),
        { status: 403 },
      );
    }

    const editableIds = await this.getEditableAgentIds(callerId, callerRole);
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
    await agent.update(patch);

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
  ): Promise<Set<string>> {
    if (role === "super_admin") {
      const allAgents = await Agent.findAll({ attributes: ["id"] });
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
