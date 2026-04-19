import { Request, Response } from "express";
import { CronJobsService } from "../../services/admin/cronJobs.service";
import { logger } from "../../logger";

export class CronJobsController {
  private service = new CronJobsService();

  listForAgent = async (req: Request, res: Response) => {
    try {
      const jobs = await this.service.listForAgent(
        req.params.agentId as string,
        req.user!.role,
        req.user!.organizationId,
      );
      return res.json(jobs);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("GET /agents/:agentId/cron-jobs error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  create = async (req: Request, res: Response) => {
    try {
      const job = await this.service.create(
        req.params.agentId as string,
        {
          name: req.body.name,
          prompt: req.body.prompt,
          cronExpression: req.body.cronExpression,
          timezone: req.body.timezone,
          enabled: req.body.enabled,
        },
        req.user!.userId,
        req.user!.role,
        req.user!.organizationId,
      );
      return res.status(201).json(job);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("POST /agents/:agentId/cron-jobs error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  update = async (req: Request, res: Response) => {
    try {
      const job = await this.service.update(
        req.params.id as string,
        {
          name: req.body.name,
          prompt: req.body.prompt,
          cronExpression: req.body.cronExpression,
          timezone: req.body.timezone,
          enabled: req.body.enabled,
        },
        req.user!.userId,
        req.user!.role,
        req.user!.organizationId,
      );
      return res.json(job);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("PATCH /cron-jobs/:id error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  delete = async (req: Request, res: Response) => {
    try {
      const result = await this.service.delete(
        req.params.id as string,
        req.user!.userId,
        req.user!.role,
        req.user!.organizationId,
      );
      return res.json(result);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("DELETE /cron-jobs/:id error:", err);
      return res.status(500).json({ error: err.message });
    }
  };
}
