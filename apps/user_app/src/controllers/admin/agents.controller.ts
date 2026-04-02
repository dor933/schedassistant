import { Request, Response } from "express";
import { AgentsService } from "../../services/admin/agents.service";
import { logger } from "../../logger";

export class AgentsController {
  private agentsService = new AgentsService();

  getAll = async (req: Request, res: Response) => {
    try {
      const agents = await this.agentsService.getAll(req.user!.userId, req.user!.role);
      return res.json(agents);
    } catch (err: any) {
      logger.error("GET /agents error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  create = async (req: Request, res: Response) => {
    try {
      const agent = await this.agentsService.create(
        req.body.definition,
        req.body.coreInstructions,
        req.body.characteristics ?? null,
        req.user!.userId,
        req.body.mcpServerIds,
        req.body.modelId,
      );
      return res.status(201).json(agent);
    } catch (err: any) {
      logger.error("POST /agents error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  update = async (req: Request, res: Response) => {
    try {
      const agent = await this.agentsService.update(
        req.params.id as string,
        req.user!.userId,
        req.user!.role,
        {
          definition: req.body.definition,
          coreInstructions: req.body.coreInstructions,
          characteristics: req.body.characteristics,
          mcpServerIds: req.body.mcpServerIds,
          modelId: req.body.modelId,
        },
      );
      return res.json(agent);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("PATCH /agents/:id error:", err);
      return res.status(500).json({ error: err.message });
    }
  };
}
