import { Request, Response } from "express";
import { AgentsService } from "../../services/admin/agents.service";
import { logger } from "../../logger";

export class AgentsController {
  private agentsService = new AgentsService();

  getAll = async (req: Request, res: Response) => {
    try {
      const agents = await this.agentsService.getAll(
        req.user!.userId,
        req.user!.role,
        req.user!.organizationId,
      );
      return res.json(agents);
    } catch (err: any) {
      logger.error("GET /agents error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  create = async (req: Request, res: Response) => {
    try {
      if (!req.body.definition?.trim()) {
        return res.status(400).json({ error: "definition is required." });
      }
      const agent = await this.agentsService.create(
        req.body.definition.trim(),
        req.body.coreInstructions,
        req.body.characteristics ?? null,
        req.user!.userId,
        req.body.mcpServerIds,
        req.body.modelId,
        req.body.skillIds,
        req.body.agentName,
        req.body.type,
        req.body.toolIds,
        req.body.description,
        req.user!.organizationId,
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
        req.user!.organizationId,
        {
          definition: req.body.definition,
          agentName: req.body.agentName,
          description: req.body.description,
          coreInstructions: req.body.coreInstructions,
          characteristics: req.body.characteristics,
          mcpServerIds: req.body.mcpServerIds,
          mcpServerLinks: req.body.mcpServerLinks,
          modelId: req.body.modelId,
          skillIds: req.body.skillIds,
          skillLinks: req.body.skillLinks,
          toolIds: req.body.toolIds,
          toolLinks: req.body.toolLinks,
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
