import { Request, Response } from "express";
import { SkillsService } from "../../services/admin/skills.service";
import { logger } from "../../logger";

export class SkillsController {
  private skillsService = new SkillsService();

  getAll = async (_req: Request, res: Response) => {
    try {
      const skills = await this.skillsService.getAll();
      return res.json(skills);
    } catch (err: any) {
      logger.error("GET /skills error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  create = async (req: Request, res: Response) => {
    try {
      const { name, skillText } = req.body ?? {};
      if (!name?.trim() || !skillText?.trim()) {
        return res.status(400).json({ error: "name and skillText are required." });
      }
      const skill = await this.skillsService.create(
        {
          name,
          slug: req.body.slug,
          description: req.body.description,
          skillText,
        },
        req.user!.userId,
      );
      return res.status(201).json(skill);
    } catch (err: any) {
      if (err.name === "SequelizeUniqueConstraintError") {
        return res.status(409).json({ error: "That slug is already in use." });
      }
      logger.error("POST /skills error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  update = async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid id." });
      }
      const skill = await this.skillsService.update(
        id,
        {
          name: req.body.name,
          slug: req.body.slug,
          description: req.body.description,
          skillText: req.body.skillText,
        },
        req.user!.userId,
      );
      return res.json(skill);
    } catch (err: any) {
      if (err.status === 404) return res.status(404).json({ error: err.message });
      if (err.name === "SequelizeUniqueConstraintError") {
        return res.status(409).json({ error: "That slug is already in use." });
      }
      logger.error("PATCH /skills/:id error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  remove = async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid id." });
      }
      await this.skillsService.remove(id, req.user!.userId);
      return res.json({ deleted: true });
    } catch (err: any) {
      if (err.status === 404) return res.status(404).json({ error: err.message });
      logger.error("DELETE /skills/:id error:", err);
      return res.status(500).json({ error: err.message });
    }
  };
}
