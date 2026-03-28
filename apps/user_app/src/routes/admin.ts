import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import { User, Role, Agent, Group, GroupMember, SingleChat, LLMModel, Vendor, Thread, EpisodicMemory, sequelize } from "@scheduling-agent/database";
import { Op } from "sequelize";
import { logger } from "../logger";
import { getIO } from "../sockets/server/socketServer";

const router = Router();

/** Broadcast an admin change to all connected users. */
function broadcastAdminChange(
  type: string,
  message: string,
  data: Record<string, unknown> = {},
  actorId?: string,
) {
  try {
    getIO().emit("admin:change", { type, message, data, actorId });
  } catch (err) {
    logger.error("broadcastAdminChange error", { error: String(err) });
  }
}

/** Only users with the "admin" role can access admin routes. */
function requireAdmin(req: any, res: any, next: any) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

router.use(authMiddleware, requireAdmin);

// ── GET /api/admin/roles ─────────────────────────────────────────────────────
router.get("/roles", async (_req, res) => {
  try {
    const roles = await Role.findAll({
      attributes: ["id", "name"],
      order: [["name", "ASC"]],
    });
    return res.json(roles);
  } catch (err: any) {
    logger.error("GET /roles error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/users ─────────────────────────────────────────────────────
router.get("/users", async (_req, res) => {
  try {
    const users = await User.findAll({
      attributes: ["id", "displayName", "userIdentity", "roleId", "createdAt"],
      order: [["created_at", "DESC"]],
    });
    // Resolve role names
    const roles = await Role.findAll({ attributes: ["id", "name"] });
    const roleMap = Object.fromEntries(roles.map((r) => [r.id, r.name]));
    return res.json(users.map((u) => ({
      id: u.id,
      displayName: u.displayName,
      userIdentity: u.userIdentity,
      role: u.roleId ? roleMap[u.roleId] ?? "user" : "user",
      roleId: u.roleId,
      createdAt: u.createdAt,
    })));
  } catch (err: any) {
    logger.error("GET /users error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/agents ────────────────────────────────────────────────────
router.get("/agents", async (_req, res) => {
  try {
    const agents = await Agent.findAll({
      attributes: ["id", "definition", "coreInstructions", "singleChatId", "groupId", "createdAt"],
      order: [["created_at", "DESC"]],
    });
    return res.json(agents);
  } catch (err: any) {
    logger.error("GET /agents error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/agents ───────────────────────────────────────────────────
router.post("/agents", async (req, res) => {
  const { definition, coreInstructions } = req.body;
  try {
    const agent = await Agent.create({
      definition: definition ?? null,
      coreInstructions: coreInstructions ?? null,
    });
    broadcastAdminChange("agent_created", `Agent "${agent.definition || "Unnamed"}" created`, { agent }, req.user!.userId);
    return res.status(201).json(agent);
  } catch (err: any) {
    logger.error("POST /agents error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/agents/:id ───────────────────────────────────────────────
router.patch("/agents/:id", async (req, res) => {
  const { definition, coreInstructions } = req.body;
  try {
    const agent = await Agent.findByPk(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    const patch: Record<string, any> = {};
    if (definition !== undefined) patch.definition = definition;
    if (coreInstructions !== undefined) patch.coreInstructions = coreInstructions;
    await agent.update(patch);
    broadcastAdminChange("agent_updated", `Agent "${agent.definition || "Unnamed"}" updated`, { agent }, req.user!.userId);
    return res.json(agent);
  } catch (err: any) {
    logger.error("PATCH /agents/:id error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/users/:id ───────────────────────────────────────────────
router.patch("/users/:id", async (req, res) => {
  const { displayName, userIdentity, roleId } = req.body;
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found." });
    const patch: Record<string, any> = {};
    if (displayName !== undefined) patch.displayName = displayName;
    if (userIdentity !== undefined) patch.userIdentity = userIdentity;
    // Only the SYSTEM user can change roles
    if (roleId !== undefined && req.user!.userId === "SYSTEM") patch.roleId = roleId;
    await user.update(patch);
    broadcastAdminChange("user_updated", `User "${user.displayName || user.id}" updated`, { userId: user.id }, req.user!.userId);
    return res.json(user);
  } catch (err: any) {
    logger.error("PATCH /users/:id error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/groups ────────────────────────────────────────────────────
router.get("/groups", async (_req, res) => {
  try {
    const groups = await Group.findAll({
      attributes: ["id", "name", "agentId", "createdAt"],
      order: [["created_at", "DESC"]],
    });
    return res.json(groups);
  } catch (err: any) {
    logger.error("GET /groups error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/groups ───────────────────────────────────────────────────
router.post("/groups", async (req, res) => {
  const { name, agentId, memberUserIds } = req.body;
  if (!name || !agentId) {
    return res.status(400).json({ error: "name and agentId are required." });
  }
  const adminUserId = req.user!.userId;
  // Require at least one non-admin member
  const extraMembers: string[] = Array.isArray(memberUserIds)
    ? memberUserIds.filter((id: string) => id !== adminUserId)
    : [];
  if (extraMembers.length === 0) {
    return res.status(400).json({ error: "At least one user (besides yourself) must be added to the group." });
  }
  try {
    // Validate the agent is unattached (exclusive assignment)
    const agent = await Agent.findByPk(agentId, { attributes: ["id", "singleChatId", "groupId", "definition"] });
    if (!agent) {
      return res.status(404).json({ error: "Agent not found." });
    }
    if (agent.singleChatId || agent.groupId) {
      return res.status(409).json({ error: "This agent is already attached to another conversation." });
    }

    const group = await Group.create({ name, agentId });

    // Link the agent to this group (exclusive assignment)
    await agent.update({ groupId: group.id });

    // Auto-add the creating admin + selected members
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

    // Notify each non-admin member so their sidebar updates in real-time
    for (const userId of extraMembers) {
      getIO().to(`user:${userId}`).emit("conversations:updated", {
        action: "group_added",
        group: {
          id: group.id,
          name: group.name,
          agentId: group.agentId,
          agentDefinition: agent?.definition ?? null,
        },
      });
    }

    broadcastAdminChange("group_created", `Group "${group.name}" created`, { group }, req.user!.userId);
    return res.status(201).json(group);
  } catch (err: any) {
    logger.error("POST /groups error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/groups/:id ───────────────────────────────────────────────
router.patch("/groups/:id", async (req, res) => {
  const { name } = req.body;
  try {
    const group = await Group.findByPk(req.params.id);
    if (!group) return res.status(404).json({ error: "Group not found." });
    if (name !== undefined) await group.update({ name });
    broadcastAdminChange("group_renamed", `Group renamed to "${group.name}"`, { groupId: group.id, name: group.name }, req.user!.userId);
    return res.json(group);
  } catch (err: any) {
    logger.error("PATCH /groups/:id error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/admin/groups/:id ─────────────────────────────────────────────
router.delete("/groups/:id", async (req, res) => {
  try {
    const group = await Group.findByPk(req.params.id, { attributes: ["id", "name", "agentId"] });
    if (!group) return res.status(404).json({ error: "Group not found." });

    // Collect member user IDs before deletion (for real-time notifications)
    const members = await GroupMember.findAll({
      where: { groupId: group.id },
      attributes: ["userId"],
    });
    const memberUserIds = members.map((m) => m.userId);

    // Find all threads for this group
    const threads = await Thread.findAll({
      where: { groupId: group.id },
      attributes: ["id"],
    });
    const threadIds = threads.map((t) => t.id);

    await sequelize.transaction(async (t) => {
      if (threadIds.length > 0) {
        // Delete episodic memory chunks linked to these threads
        await EpisodicMemory.destroy({
          where: { threadId: { [Op.in]: threadIds } },
          transaction: t,
        });

        // Delete checkpoint data (blobs + writes + checkpoints)
        for (const tid of threadIds) {
          await sequelize.query(
            `DELETE FROM checkpoint_blobs WHERE thread_id = :tid`,
            { replacements: { tid }, transaction: t },
          );
          await sequelize.query(
            `DELETE FROM checkpoint_writes WHERE thread_id = :tid`,
            { replacements: { tid }, transaction: t },
          );
          await sequelize.query(
            `DELETE FROM checkpoints WHERE thread_id = :tid`,
            { replacements: { tid }, transaction: t },
          );
        }

        // Delete threads
        await Thread.destroy({
          where: { groupId: group.id },
          transaction: t,
        });
      }

      // GroupMembers are CASCADE-deleted, but explicit delete ensures it's in the transaction
      await GroupMember.destroy({ where: { groupId: group.id }, transaction: t });

      // Delete the group itself
      await group.destroy({ transaction: t });
    });

    // Agent.groupId is SET NULL by the DB FK cascade — agent is already freed.

    // Notify each member so their sidebar removes the group
    for (const userId of memberUserIds) {
      getIO().to(`user:${userId}`).emit("conversations:updated", {
        action: "group_removed",
        groupId: group.id,
      });
    }

    const groupName = group.name;
    broadcastAdminChange("group_deleted", `Group "${groupName}" deleted`, { groupId: group.id }, req.user!.userId);

    logger.info("Group deleted with cascade", { groupId: group.id, groupName, threadCount: threadIds.length });

    return res.json({ deleted: true });
  } catch (err: any) {
    logger.error("DELETE /groups/:id error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/groups/:groupId/members ───────────────────────────────────
router.get("/groups/:groupId/members", async (req, res) => {
  try {
    const members = await GroupMember.findAll({
      where: { groupId: req.params.groupId },
      attributes: ["id", "userId", "createdAt"],
    });
    return res.json(members);
  } catch (err: any) {
    logger.error("GET /groups/:id/members error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/groups/:groupId/members ──────────────────────────────────
router.post("/groups/:groupId/members", async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: "userId is required." });
  }
  try {
    const [member, created] = await GroupMember.findOrCreate({
      where: { groupId: req.params.groupId, userId },
      defaults: { groupId: req.params.groupId, userId },
    });

    // Notify the added user so their sidebar updates in real-time
    if (created) {
      const group = await Group.findByPk(req.params.groupId, {
        attributes: ["id", "name", "agentId", "modelId"],
      });
      if (group) {
        const agent = await Agent.findByPk(group.agentId, { attributes: ["definition"] });
        getIO().to(`user:${userId}`).emit("conversations:updated", {
          action: "group_added",
          group: {
            id: group.id,
            name: group.name,
            agentId: group.agentId,
            agentDefinition: agent?.definition ?? null,
          },
        });
      }
    }

    if (created) {
      broadcastAdminChange("group_member_added", `Member added to group`, { groupId: req.params.groupId, userId }, req.user!.userId);
    }
    return res.status(created ? 201 : 200).json(member);
  } catch (err: any) {
    logger.error("POST /groups/:id/members error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/admin/groups/:groupId/members/:userId ────────────────────────
router.delete("/groups/:groupId/members/:userId", async (req, res) => {
  try {
    const deleted = await GroupMember.destroy({
      where: { groupId: req.params.groupId, userId: req.params.userId },
    });

    // Notify the removed user so their sidebar updates
    if (deleted > 0) {
      getIO().to(`user:${req.params.userId}`).emit("conversations:updated", {
        action: "group_removed",
        groupId: req.params.groupId,
      });
      broadcastAdminChange("group_member_removed", `Member removed from group`, { groupId: req.params.groupId, userId: req.params.userId }, req.user!.userId);
    }

    return res.json({ deleted });
  } catch (err: any) {
    logger.error("DELETE member error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/models ─────────────────────────────────────────────────────
router.get("/models", async (_req, res) => {
  try {
    const models = await LLMModel.findAll({
      attributes: ["id", "vendorId", "name", "slug"],
      order: [["name", "ASC"]],
    });
    const vendors = await Vendor.findAll({ attributes: ["id", "name", "slug"] });
    const vendorMap = Object.fromEntries(vendors.map((v) => [v.id, { id: v.id, name: v.name, slug: v.slug }]));
    const result = models.map((m) => ({
      id: m.id,
      name: m.name,
      slug: m.slug,
      vendor: vendorMap[m.vendorId] ?? null,
    }));
    return res.json(result);
  } catch (err: any) {
    logger.error("GET /models error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/vendors ────────────────────────────────────────────────────
router.get("/vendors", async (_req, res) => {
  try {
    const vendors = await Vendor.findAll({
      attributes: ["id", "name", "slug", "apiKey"],
      order: [["name", "ASC"]],
    });
    // Never send the actual key to the client — only whether one is set.
    return res.json(vendors.map((v) => ({ id: v.id, name: v.name, slug: v.slug, hasApiKey: !!v.apiKey })));
  } catch (err: any) {
    logger.error("GET /vendors error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/models ───────────────────────────────────────────────────
router.post("/models", async (req, res) => {
  const { vendorId, name, slug } = req.body;
  if (!vendorId || !name || !slug) {
    return res.status(400).json({ error: "vendorId, name, and slug are required." });
  }

  try {
    // Check vendor exists
    const vendor = await Vendor.findByPk(vendorId);
    if (!vendor) return res.status(404).json({ error: "Vendor not found." });

    // Check for duplicate slug
    const existingSlug = await LLMModel.findOne({ where: { slug } });
    if (existingSlug) {
      return res.status(409).json({ error: `A model with slug "${slug}" already exists.` });
    }

    // Check for duplicate name within same vendor
    const existingName = await LLMModel.findOne({ where: { vendorId, name } });
    if (existingName) {
      return res.status(409).json({ error: `A model named "${name}" already exists for ${vendor.name}.` });
    }

    const model = await LLMModel.create({ vendorId, name, slug });
    const result = {
      id: model.id,
      name: model.name,
      slug: model.slug,
      vendor: { id: vendor.id, name: vendor.name, slug: vendor.slug },
    };
    broadcastAdminChange("model_created", `Model "${name}" added`, { model: result }, req.user!.userId);
    return res.status(201).json(result);
  } catch (err: any) {
    logger.error("POST /models error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/admin/models/:id ─────────────────────────────────────────────
router.delete("/models/:id", async (req, res) => {
  try {
    const model = await LLMModel.findByPk(req.params.id);
    if (!model) return res.status(404).json({ error: "Model not found." });

    // Check if any single chats or groups are using this model
    const scCount = await SingleChat.count({ where: { modelId: req.params.id } });
    const gCount = await Group.count({ where: { modelId: req.params.id } });
    if (scCount > 0 || gCount > 0) {
      return res.status(409).json({
        error: `Cannot delete — this model is in use by ${scCount} chat(s) and ${gCount} group(s). Switch them to a different model first.`,
      });
    }

    const modelName = model.name;
    await model.destroy();
    broadcastAdminChange("model_deleted", `Model "${modelName}" deleted`, { modelId: req.params.id }, req.user!.userId);
    return res.json({ deleted: true });
  } catch (err: any) {
    logger.error("DELETE /models/:id error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── Helper: check if vendor API key is configured ────────────────────────────
async function validateModelApiKey(modelId: string): Promise<string | null> {
  const model = await LLMModel.findByPk(modelId, { attributes: ["vendorId"] });
  if (!model) return "Model not found.";
  const vendor = await Vendor.findByPk(model.vendorId, { attributes: ["name", "apiKey"] });
  if (!vendor) return "Vendor not found.";
  if (!vendor.apiKey) {
    return `API key not configured for ${vendor.name}. Set it in the admin panel first.`;
  }
  return null;
}

// ── PATCH /api/admin/vendors/:id/api-key ────────────────────────────────────
router.patch("/vendors/:id/api-key", async (req, res) => {
  const { apiKey } = req.body;
  if (apiKey !== undefined && typeof apiKey !== "string") {
    return res.status(400).json({ error: "apiKey must be a string." });
  }
  try {
    const vendor = await Vendor.findByPk(req.params.id);
    if (!vendor) return res.status(404).json({ error: "Vendor not found." });
    await vendor.update({ apiKey: apiKey || null });
    broadcastAdminChange("vendor_api_key_updated", `API key ${apiKey ? "set" : "removed"} for ${vendor.name}`, { vendorId: vendor.id, vendorName: vendor.name, hasApiKey: !!apiKey }, req.user!.userId);
    return res.json({ id: vendor.id, name: vendor.name, slug: vendor.slug, hasApiKey: !!apiKey });
  } catch (err: any) {
    logger.error("PATCH /vendors/:id/api-key error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/single-chats/:id/model ──────────────────────────────────
router.patch("/single-chats/:id/model", async (req, res) => {
  const { modelId } = req.body;
  try {
    const sc = await SingleChat.findByPk(req.params.id);
    if (!sc) return res.status(404).json({ error: "Single chat not found." });

    if (modelId) {
      const keyError = await validateModelApiKey(modelId);
      if (keyError) return res.status(400).json({ error: keyError });
    }

    await sc.update({ modelId: modelId ?? null });

    // Resolve full model info for the broadcast
    let modelInfo = null;
    if (modelId) {
      const m = await LLMModel.findByPk(modelId, { attributes: ["id", "name", "slug", "vendorId"] });
      if (m) {
        const v = await Vendor.findByPk(m.vendorId, { attributes: ["id", "name", "slug"] });
        modelInfo = { id: m.id, name: m.name, slug: m.slug, vendor: v ? { id: v.id, name: v.name, slug: v.slug } : null };
      }
    }
    broadcastAdminChange("single_chat_model_changed", `Chat model changed to ${modelInfo?.name ?? "default"}`, { singleChatId: req.params.id, model: modelInfo }, req.user!.userId);

    return res.json(sc);
  } catch (err: any) {
    logger.error("PATCH single-chat model error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/groups/:id/model ────────────────────────────────────────
router.patch("/groups/:id/model", async (req, res) => {
  const { modelId } = req.body;
  try {
    const group = await Group.findByPk(req.params.id);
    if (!group) return res.status(404).json({ error: "Group not found." });

    if (modelId) {
      const keyError = await validateModelApiKey(modelId);
      if (keyError) return res.status(400).json({ error: keyError });
    }

    await group.update({ modelId: modelId ?? null });

    // Resolve full model info for the broadcast
    let modelInfo = null;
    if (modelId) {
      const m = await LLMModel.findByPk(modelId, { attributes: ["id", "name", "slug", "vendorId"] });
      if (m) {
        const v = await Vendor.findByPk(m.vendorId, { attributes: ["id", "name", "slug"] });
        modelInfo = { id: m.id, name: m.name, slug: m.slug, vendor: v ? { id: v.id, name: v.name, slug: v.slug } : null };
      }
    }
    broadcastAdminChange("group_model_changed", `Group "${group.name}" model changed to ${modelInfo?.name ?? "default"}`, { groupId: group.id, model: modelInfo }, req.user!.userId);

    return res.json(group);
  } catch (err: any) {
    logger.error("PATCH group model error:", err);
    return res.status(500).json({ error: err.message });
  }
});

export { router as adminRouter };
