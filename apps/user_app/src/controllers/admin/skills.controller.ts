import { Request, Response } from "express";
import { SkillsService } from "../../services/admin/skills.service";
import { logger } from "../../logger";

/**
 * Read-only controller: skills are a platform-wide catalog managed out-of-band.
 * See `mcpServers.controller.ts` for the pattern.
 */
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
}
