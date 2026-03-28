import { Router } from "express";
import bcrypt from "bcrypt";
import { User, Group, GroupMember, SingleChat, Agent, LLMModel, Vendor } from "@scheduling-agent/database";
import { registerSchema, loginSchema } from "@scheduling-agent/types";
import { signToken, authMiddleware } from "../middleware/auth";
import { logger } from "../logger";

const SALT_ROUNDS = 10;

const router = Router();

// ── POST /api/auth/register ──────────────────────────────────────────────────
router.post("/register", async (_req, res) => {
  return res.status(503).json({ error: "Registration not available — please try later." });

  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    const firstError = parsed.error.errors[0]?.message ?? "Invalid input.";
    return res.status(400).json({ error: firstError });
  }

  const { userName, displayName, password, userIdentity } = parsed.data;

  // Check username uniqueness (case-insensitive — userName is already lowercased by schema)
  const existing = await User.findOne({ where: { userName } });
  if (existing) {
    return res.status(409).json({ error: "Username is already taken." });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const user = await User.create({
      userName,
      displayName,
      password: hashedPassword,
      userIdentity: userIdentity ?? null,
    });

    // Create a personal agent for this user
    const agent = await Agent.create({
      definition: `${displayName}'s Agent`,
      coreInstructions: "You are a helpful AI assistant.",
    });

    // Create the default single chat linked to the personal agent
    const sc = await SingleChat.create({
      userId: user.id,
      agentId: agent.id,
      title: "Default Chat",
    });

    // Link the agent to this single chat (exclusive assignment)
    await agent.update({ singleChatId: sc.id });

    const token = signToken({
      userId: user.id,
      displayName: user.displayName,
    });

    const conversations = await loadUserConversations(user.id);

    return res.status(201).json({
      token,
      user: {
        id: user.id,
        displayName: user.displayName,
        userIdentity: user.userIdentity,
      },
      conversations,
    });
  } catch (err: any) {
    logger.error("Register error", { error: err?.message });
    if (err.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({ error: "Username is already taken." });
    }
    return res.status(500).json({ error: "Internal server error." });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    const firstError = parsed.error.errors[0]?.message ?? "Invalid input.";
    return res.status(400).json({ error: firstError });
  }

  const { userName, password } = parsed.data;

  try {
    const user = await User.findOne({ where: { userName } });
    if (!user || !user.password) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // Ensure the user has at least one single chat with a personal agent
    const existingChats = await SingleChat.findAll({ where: { userId: user.id }, limit: 1 });
    if (existingChats.length === 0) {
      const agent = await Agent.create({
        definition: `${user.displayName || "User"}'s Agent`,
        coreInstructions: "You are a helpful AI assistant.",
      });
      const sc = await SingleChat.create({
        userId: user.id,
        agentId: agent.id,
        title: "Default Chat",
      });
      await agent.update({ singleChatId: sc.id });
    }

    const token = signToken({
      userId: user.id,
      displayName: user.displayName,
    });

    const conversations = await loadUserConversations(user.id);

    return res.json({
      token,
      user: {
        id: user.id,
        displayName: user.displayName,
        userIdentity: user.userIdentity,
      },
      conversations,
    });
  } catch (err: any) {
    logger.error("Login error", { error: err?.message });
    return res.status(500).json({ error: "Internal server error." });
  }
});

// ── Helper: resolve model info from modelId ──────────────────────────────────
async function resolveModelInfo(modelId: string | null) {
  if (!modelId) return null;
  const model = await LLMModel.findByPk(modelId, { attributes: ["id", "name", "slug", "vendorId"] });
  if (!model) return null;
  const vendor = await Vendor.findByPk(model.vendorId, { attributes: ["id", "name", "slug"] });
  return {
    id: model.id,
    name: model.name,
    slug: model.slug,
    vendor: vendor ? { id: vendor.id, name: vendor.name, slug: vendor.slug } : null,
  };
}

// ── Helper: load groups + single chats for a user ───────────────────────────
async function loadUserConversations(userId: string) {
  // Groups the user belongs to (via group_members)
  const memberships = await GroupMember.findAll({
    where: { userId },
    attributes: ["groupId"],
  });
  const groupIds = memberships.map((m) => m.groupId);

  let groups: any[] = [];
  if (groupIds.length > 0) {
    const groupRows = await Group.findAll({
      where: { id: groupIds },
      attributes: ["id", "name", "agentId", "modelId"],
      order: [["name", "ASC"]],
    });
    groups = await Promise.all(
      groupRows.map(async (g) => {
        const agent = await Agent.findByPk(g.agentId, { attributes: ["definition"] });
        return {
          id: g.id,
          name: g.name,
          agentId: g.agentId,
          agentDefinition: agent?.definition ?? null,
          model: await resolveModelInfo(g.modelId),
        };
      }),
    );
  }

  // Single chats (1:1 with agents)
  const singleChatRows = await SingleChat.findAll({
    where: { userId },
    attributes: ["id", "agentId", "modelId", "title"],
    order: [["created_at", "DESC"]],
  });
  const singleChats = await Promise.all(
    singleChatRows.map(async (sc) => ({
      id: sc.id,
      agentId: sc.agentId,
      title: sc.title,
      model: await resolveModelInfo(sc.modelId),
    })),
  );

  return { groups, singleChats };
}

// ── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findByPk(req.user!.userId, {
      attributes: ["id", "displayName", "userIdentity"],
    });
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    const conversations = await loadUserConversations(user.id);

    return res.json({
      id: user.id,
      displayName: user.displayName,
      userIdentity: user.userIdentity,
      conversations,
    });
  } catch (err: any) {
    logger.error("/me error", { error: err?.message });
    return res.status(500).json({ error: "Internal server error." });
  }
});

export { router as authRouter };
