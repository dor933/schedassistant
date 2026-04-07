import { Request, Response } from "express";
import { SystemAgent, SystemAgentMcpServer, SystemAgentSkill, Skill } from "@scheduling-agent/database";
import { Op } from "sequelize";
import { logger } from "../../logger";

export class SystemAgentsController {
  getAll = async (_req: Request, res: Response) => {
    try {
      const agents = await SystemAgent.findAll({
        attributes: ["id", "slug", "name", "description", "instructions", "modelSlug", "userId", "toolConfig"],
        order: [["name", "ASC"]],
      });

      const mcpLinks = await SystemAgentMcpServer.findAll({
        attributes: ["systemAgentId", "mcpServerId"],
      });
      const mcpByAgent: Record<number, number[]> = {};
      for (const link of mcpLinks) {
        (mcpByAgent[link.systemAgentId] ??= []).push(link.mcpServerId);
      }

      const skillLinks = await SystemAgentSkill.findAll({
        attributes: ["systemAgentId", "skillId"],
      });
      const skillsByAgent: Record<number, number[]> = {};
      for (const link of skillLinks) {
        (skillsByAgent[link.systemAgentId] ??= []).push(link.skillId);
      }

      const result = agents.map((a) => {
        const { toolConfig, ...rest } = a.toJSON();
        const tc = toolConfig as Record<string, unknown> | null;
        return {
          ...rest,
          locked: !!(tc?.locked),
          mcpServerIds: mcpByAgent[a.id] ?? [],
          skillIds: skillsByAgent[a.id] ?? [],
        };
      });

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

    const { slug, name, description, instructions, modelSlug, mcpServerIds, skillIds } = req.body;

    if (!slug?.trim() || !name?.trim() || !instructions?.trim()) {
      return res.status(400).json({ error: "Slug, name, and instructions are required." });
    }

    const resolvedModelSlug = modelSlug?.trim() || "gpt-4o";
    if (resolvedModelSlug.startsWith("gemini")) {
      return res.status(400).json({ error: "Google (Gemini) models are not supported." });
    }

    try {
      const agent = await SystemAgent.create({
        slug: slug.trim(),
        name: name.trim(),
        description: description?.trim() || null,
        instructions: instructions.trim(),
        modelSlug: resolvedModelSlug,
        userId: req.user!.userId,
      });

      if (Array.isArray(mcpServerIds) && mcpServerIds.length > 0) {
        await SystemAgentMcpServer.bulkCreate(
          mcpServerIds.map((mcpServerId: number) => ({
            systemAgentId: agent.id,
            mcpServerId,
          })),
        );
      }

      let validSkillIds: number[] = [];
      if (Array.isArray(skillIds) && skillIds.length > 0) {
        const blocked = await Skill.findAll({
          where: { id: { [Op.in]: skillIds }, systemAgentAssignable: false },
          attributes: ["id", "name"],
        });
        if (blocked.length > 0) {
          await agent.destroy();
          const names = blocked.map((s) => s.name).join(", ");
          return res.status(400).json({
            error: `These skills cannot be assigned to system agents: ${names}`,
          });
        }
        validSkillIds = skillIds;
        await SystemAgentSkill.bulkCreate(
          validSkillIds.map((skillId: number) => ({
            systemAgentId: agent.id,
            skillId,
          })),
        );
      }

      return res.status(201).json({
        ...agent.toJSON(),
        mcpServerIds: mcpServerIds ?? [],
        skillIds: validSkillIds,
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

    const tc = agent.toolConfig as Record<string, unknown> | null;
    if (tc?.locked) {
      return res.status(403).json({ error: "This system agent is locked and cannot be edited." });
    }

    try {
      const { name, description, instructions, modelSlug, userId, mcpServerIds, skillIds } = req.body;

      const patch: Record<string, any> = {};
      if (name !== undefined) patch.name = name;
      if (description !== undefined) patch.description = description;
      if (instructions !== undefined) patch.instructions = instructions;
      if (modelSlug !== undefined) {
        if (typeof modelSlug === "string" && modelSlug.trim().startsWith("gemini")) {
          return res.status(400).json({ error: "Google (Gemini) models are not supported." });
        }
        patch.modelSlug = modelSlug;
      }
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

      if (skillIds !== undefined) {
        if (Array.isArray(skillIds) && skillIds.length > 0) {
          const blocked = await Skill.findAll({
            where: { id: { [Op.in]: skillIds }, systemAgentAssignable: false },
            attributes: ["id", "name"],
          });
          if (blocked.length > 0) {
            const names = blocked.map((s) => s.name).join(", ");
            return res.status(400).json({
              error: `These skills cannot be assigned to system agents: ${names}`,
            });
          }
        }
        await SystemAgentSkill.destroy({ where: { systemAgentId: agent.id } });
        if (Array.isArray(skillIds) && skillIds.length > 0) {
          await SystemAgentSkill.bulkCreate(
            skillIds.map((sid: number) => ({
              systemAgentId: agent.id,
              skillId: sid,
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

      const currentSkillIds = skillIds !== undefined
        ? skillIds
        : (await SystemAgentSkill.findAll({
            where: { systemAgentId: agent.id },
            attributes: ["skillId"],
          })).map((l) => l.skillId);

      return res.json({
        ...agent.toJSON(),
        mcpServerIds: currentMcpIds,
        skillIds: currentSkillIds,
      });
    } catch (err: any) {
      logger.error("PATCH /system-agents/:id error:", err);
      return res.status(500).json({ error: err.message });
    }
  };
}
