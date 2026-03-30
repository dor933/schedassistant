import {
  User, Role, Agent, Group, GroupMember, SingleChat, LLMModel, Vendor,
  ConversationMessage, sequelize,
} from "@scheduling-agent/database";
import { getIO } from "../../sockets/server/socketServer";
import { logger } from "../../logger";

export class GroupsService {
  async getAll() {
    return Group.findAll({
      attributes: ["id", "name", "agentId", "createdAt"],
      order: [["created_at", "DESC"]],
    });
  }

  async create(name: string, agentId: string, memberUserIds: string[], adminUserId: string) {
    const extraMembers: string[] = Array.isArray(memberUserIds)
      ? memberUserIds.filter((id: string) => id !== adminUserId)
      : [];
    if (extraMembers.length === 0) {
      throw Object.assign(new Error("At least one user (besides yourself) must be added to the group."), { status: 400 });
    }

    const agent = await Agent.findByPk(agentId, { attributes: ["id", "definition"] });
    if (!agent) throw Object.assign(new Error("Agent not found."), { status: 404 });

    const group = await Group.create({ name, agentId });

    const allMembers = [adminUserId, ...extraMembers];
    const uniqueMembers = [...new Set(allMembers)];
    await Promise.all(
      uniqueMembers.map((userId) =>
        GroupMember.findOrCreate({
          where: { groupId: group.id, userId },
          defaults: { groupId: group.id, userId },
        }),
      ),
    );

    for (const userId of extraMembers) {
      getIO().to(`user:${userId}`).emit("conversations:updated", {
        action: "group_added",
        group: { id: group.id, name: group.name, agentId: group.agentId, agentDefinition: agent?.definition ?? null },
      });
    }

    this.broadcast("group_created", `Group "${group.name}" created`, { group }, adminUserId);
    return group;
  }

  async rename(groupId: string, name: string, actorId: string) {
    const group = await Group.findByPk(groupId);
    if (!group) throw Object.assign(new Error("Group not found."), { status: 404 });
    if (name !== undefined) await group.update({ name });
    this.broadcast("group_renamed", `Group renamed to "${group.name}"`, { groupId: group.id, name: group.name }, actorId);
    return group;
  }

  async remove(groupId: string, actorId: string) {
    const group = await Group.findByPk(groupId, { attributes: ["id", "name", "agentId"] });
    if (!group) throw Object.assign(new Error("Group not found."), { status: 404 });

    const members = await GroupMember.findAll({ where: { groupId: group.id }, attributes: ["userId"] });
    const memberUserIds = members.map((m) => m.userId);

    await sequelize.transaction(async (t) => {
      await ConversationMessage.destroy({ where: { groupId: group.id }, transaction: t });
      await GroupMember.destroy({ where: { groupId: group.id }, transaction: t });
      await group.destroy({ transaction: t });
    });

    for (const userId of memberUserIds) {
      getIO().to(`user:${userId}`).emit("conversations:updated", { action: "group_removed", groupId: group.id });
    }

    const groupName = group.name;
    this.broadcast("group_deleted", `Group "${groupName}" deleted`, { groupId: group.id }, actorId);
    logger.info("Group deleted", { groupId: group.id, groupName });
    return { deleted: true };
  }

  async getMembers(groupId: string) {
    return GroupMember.findAll({
      where: { groupId },
      attributes: ["id", "userId", "createdAt"],
    });
  }

  async addMember(groupId: string, userId: string, actorId: string) {
    const [member, created] = await GroupMember.findOrCreate({
      where: { groupId, userId },
      defaults: { groupId, userId },
    });

    if (created) {
      const group = await Group.findByPk(groupId, { attributes: ["id", "name", "agentId", "modelId"] });
      if (group) {
        const agent = await Agent.findByPk(group.agentId, { attributes: ["definition"] });
        getIO().to(`user:${userId}`).emit("conversations:updated", {
          action: "group_added",
          group: { id: group.id, name: group.name, agentId: group.agentId, agentDefinition: agent?.definition ?? null },
        });
      }
      this.broadcast("group_member_added", `Member added to group`, { groupId, userId }, actorId);
    }

    return { member, created };
  }

  async removeMember(groupId: string, targetUserId: string, actorId: string) {
    const targetUser = await User.findByPk(targetUserId, { attributes: ["roleId"] });
    if (targetUser?.roleId) {
      const targetRole = await Role.findByPk(targetUser.roleId, { attributes: ["name"] });
      if (targetRole?.name === "super_admin") {
        throw Object.assign(new Error("A super admin cannot be removed from groups."), { status: 403 });
      }
    }

    const deleted = await GroupMember.destroy({ where: { groupId, userId: targetUserId } });

    if (deleted > 0) {
      getIO().to(`user:${targetUserId}`).emit("conversations:updated", { action: "group_removed", groupId });
      this.broadcast("group_member_removed", `Member removed from group`, { groupId, userId: targetUserId }, actorId);
    }

    return { deleted };
  }

  async setModel(groupId: string, modelId: string | null, actorId: string) {
    const group = await Group.findByPk(groupId);
    if (!group) throw Object.assign(new Error("Group not found."), { status: 404 });

    if (modelId) {
      const keyError = await this.validateModelApiKey(modelId);
      if (keyError) throw Object.assign(new Error(keyError), { status: 400 });
    }

    await group.update({ modelId: modelId ?? null });

    let modelInfo = null;
    if (modelId) {
      const m = await LLMModel.findByPk(modelId, { attributes: ["id", "name", "slug", "vendorId"] });
      if (m) {
        const v = await Vendor.findByPk(m.vendorId, { attributes: ["id", "name", "slug"] });
        modelInfo = { id: m.id, name: m.name, slug: m.slug, vendor: v ? { id: v.id, name: v.name, slug: v.slug } : null };
      }
    }
    this.broadcast("group_model_changed", `Group "${group.name}" model changed to ${modelInfo?.name ?? "default"}`, { groupId: group.id, model: modelInfo }, actorId);
    return group;
  }

  private async validateModelApiKey(modelId: string): Promise<string | null> {
    const model = await LLMModel.findByPk(modelId, { attributes: ["vendorId"] });
    if (!model) return "Model not found.";
    const vendor = await Vendor.findByPk(model.vendorId, { attributes: ["name", "apiKey"] });
    if (!vendor) return "Vendor not found.";
    if (!vendor.apiKey) return `API key not configured for ${vendor.name}. Set it in the admin panel first.`;
    return null;
  }

  private broadcast(type: string, message: string, data: Record<string, unknown>, actorId: string) {
    try {
      getIO().emit("admin:change", { type, message, data, actorId });
    } catch (err) {
      logger.error("broadcastAdminChange error", { error: String(err) });
    }
  }
}
