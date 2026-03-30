import {
  User,
  Agent,
  SingleChat,
  GroupMember,
  Group,
} from "@scheduling-agent/database";
import { getIO } from "../../sockets/server/socketServer";
import { logger } from "../../logger";

export class AgentsService {
  async getAll(callerId: string, callerRole: string) {
    const agents = await Agent.findAll({
      attributes: [
        "id",
        "definition",
        "coreInstructions",
        "groupId",
        "createdAt",
      ],
      order: [["created_at", "DESC"]],
    });

    const editableIds = await this.getEditableAgentIds(callerId, callerRole);

    return agents.map((a) => ({
      ...a.toJSON(),
      editable: editableIds.has(a.id),
    }));
  }

  async create(
    definition?: string,
    coreInstructions?: string,
    actorId?: string,
  ) {
    const agent = await Agent.create({
      definition: definition ?? null,
      coreInstructions: coreInstructions ?? null,
    });
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
    callerId: string,
    callerRole: string,
    data: { definition?: string; coreInstructions?: string },
  ) {
    const agent = await Agent.findByPk(agentId);
    if (!agent)
      throw Object.assign(new Error("Agent not found."), { status: 404 });

    const editableIds = await this.getEditableAgentIds(callerId, callerRole);
    if (!editableIds.has(agent.id)) {
      throw Object.assign(
        new Error("You do not have permission to edit this agent."),
        { status: 403 },
      );
    }

    const patch: Record<string, any> = {};
    if (data.definition !== undefined) patch.definition = data.definition;
    if (data.coreInstructions !== undefined)
      patch.coreInstructions = data.coreInstructions;
    await agent.update(patch);
    this.broadcast(
      "agent_updated",
      `Agent "${agent.definition || "Unnamed"}" updated`,
      { agent },
      callerId,
    );
    return agent;
  }

  async getEditableAgentIds(
    userId: string,
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

  private broadcast(
    type: string,
    message: string,
    data: Record<string, unknown>,
    actorId?: string,
  ) {
    try {
      getIO().emit("admin:change", { type, message, data, actorId });
    } catch (err) {
      logger.error("broadcastAdminChange error", { error: String(err) });
    }
  }
}
