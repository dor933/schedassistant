import fs from "node:fs";
import path from "node:path";
import {
  Agent,
  SingleChat,
  User,
  LLMModel,
  Vendor,
} from "@scheduling-agent/database";
import { getIO } from "../../sockets/server/socketServer";
import { logger } from "../../logger";
import type { UserId } from "@scheduling-agent/types";

const WORKSPACES_ROOT = path.join(process.env.DATA_DIR || "/app/data", "workspaces");

export class AgentsService {
  async getAll(callerId: UserId, callerRole: string) {
    const agents = await Agent.findAll({
      attributes: [
        "id",
        "definition",
        "agentName",
        "coreInstructions",
        "characteristics",
        "createdByUserId",
        "modelId",
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
    definition: string,
    coreInstructions?: string,
    characteristics?: Record<string, unknown> | null,
    actorId?: UserId,
    modelId?: string | null,
    agentName?: string | null,
  ) {
    const normalizedAgentName =
      agentName !== undefined && agentName !== null && String(agentName).trim() !== ""
        ? String(agentName).trim()
        : null;
    const agent = await Agent.create({
      definition,
      agentName: normalizedAgentName,
      coreInstructions: coreInstructions ?? null,
      characteristics: characteristics ?? null,
      createdByUserId: actorId ?? null,
      modelId: modelId ?? null,
    });

    // Create persistent workspace folder for this agent (using definition as folder name)
    const workspacePath = path.join(WORKSPACES_ROOT, agent.definition);
    try {
      fs.mkdirSync(workspacePath, { recursive: true });
      await agent.update({ workspacePath });
    } catch (err) {
      logger.error("Failed to create workspace for agent", { agentId: agent.id, error: String(err) });
    }

    // Eagerly create a SingleChat for every user and notify them in real time
    try {
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
      modelId?: string | null;
    },
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
    if (data.modelId !== undefined) patch.modelId = data.modelId;
    await agent.update(patch);

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

    return ids;
  }

  /**
   * Notifies all users who have a SingleChat with this agent that the agent's model has changed.
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
