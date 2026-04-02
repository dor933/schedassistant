import { Request, Response } from "express";
import { SystemAgent, SystemAgentMcpServer } from "@scheduling-agent/database";
import { logger } from "../../logger";

export class SystemAgentsController {
  getAll = async (_req: Request, res: Response) => {
    try {
      const agents = await SystemAgent.findAll({
        attributes: ["id", "slug", "name", "description", "instructions", "modelSlug", "userId"],
        order: [["name", "ASC"]],
      });

      const mcpLinks = await SystemAgentMcpServer.findAll({
        attributes: ["systemAgentId", "mcpServerId"],
      });
      const mcpByAgent: Record<number, number[]> = {};
      for (const link of mcpLinks) {
        (mcpByAgent[link.systemAgentId] ??= []).push(link.mcpServerId);
      }

      const result = agents.map((a) => ({
        ...a.toJSON(),
        mcpServerIds: mcpByAgent[a.id] ?? [],
      }));

      return res.json(result);
    } catch (err: any) {
      logger.error("GET /system-agents error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  create = async (req: Request, res: Response) => {
    if (req.user!.role !== "super_admin") {
      return res.status(403).json({ error: "Only super admins can manage system agents." });
    }

    const { slug, name, description, instructions, modelSlug, userId, mcpServerIds } = req.body;

    if (!slug?.trim() || !name?.trim() || !instructions?.trim()) {
      return res.status(400).json({ error: "Slug, name, and instructions are required." });
    }

    try {
      const agent = await SystemAgent.create({
        slug: slug.trim(),
        name: name.trim(),
        description: description?.trim() || null,
        instructions: instructions.trim(),
        modelSlug: modelSlug?.trim() || "gpt-4o",
        userId: userId ?? null,
      });

      if (Array.isArray(mcpServerIds) && mcpServerIds.length > 0) {
        await SystemAgentMcpServer.bulkCreate(
          mcpServerIds.map((mcpServerId: number) => ({
            systemAgentId: agent.id,
            mcpServerId,
          })),
        );
      }

      return res.status(201).json({
        ...agent.toJSON(),
        mcpServerIds: mcpServerIds ?? [],
      });
    } catch (err: any) {
      if (err.name === "SequelizeUniqueConstraintError") {
        return res.status(409).json({ error: `A system agent with slug "${slug.trim()}" already exists.` });
      }
      logger.error("POST /system-agents error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  update = async (req: Request, res: Response) => {
    if (req.user!.role !== "super_admin") {
      return res.status(403).json({ error: "Only super admins can manage system agents." });
    }

    const id = Number(req.params.id);
    const agent = await SystemAgent.findByPk(id);
    if (!agent) {
      return res.status(404).json({ error: "System agent not found." });
    }

    try {
      const { name, description, instructions, modelSlug, userId, mcpServerIds } = req.body;

      const patch: Record<string, any> = {};
      if (name !== undefined) patch.name = name;
      if (description !== undefined) patch.description = description;
      if (instructions !== undefined) patch.instructions = instructions;
      if (modelSlug !== undefined) patch.modelSlug = modelSlug;
      if (userId !== undefined) patch.userId = userId;
      await agent.update(patch);

      if (mcpServerIds !== undefined) {
        await SystemAgentMcpServer.destroy({ where: { systemAgentId: agent.id } });
        if (Array.isArray(mcpServerIds) && mcpServerIds.length > 0) {
          await SystemAgentMcpServer.bulkCreate(
            mcpServerIds.map((mcpServerId: number) => ({
              systemAgentId: agent.id,
              mcpServerId,
            })),
          );
        }
      }

      const currentMcpIds = mcpServerIds !== undefined
        ? mcpServerIds
        : (await SystemAgentMcpServer.findAll({
            where: { systemAgentId: agent.id },
            attributes: ["mcpServerId"],
          })).map((l) => l.mcpServerId);

      return res.json({
        ...agent.toJSON(),
        mcpServerIds: currentMcpIds,
      });
    } catch (err: any) {
      logger.error("PATCH /system-agents/:id error:", err);
      return res.status(500).json({ error: err.message });
    }
  };
}
