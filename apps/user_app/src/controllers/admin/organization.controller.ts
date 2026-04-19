import { Request, Response } from "express";
import { organizationSummarySchema } from "@scheduling-agent/types";
import { OrganizationService } from "../../services/admin/organization.service";
import { logger } from "../../logger";

export class OrganizationController {
  private service = new OrganizationService();

  get = async (req: Request, res: Response) => {
    try {
      const data = await this.service.get(req.user!.organizationId);
      return res.json(data);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("GET /admin/organization error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  setSummary = async (req: Request, res: Response) => {
    const parsed = organizationSummarySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? "Invalid summary.",
      });
    }

    try {
      const data = await this.service.setSummary(
        req.user!.organizationId,
        parsed.data.summary,
        req.user!.userId,
      );
      return res.json(data);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("PATCH /admin/organization/summary error:", err);
      return res.status(500).json({ error: err.message });
    }
  };
}
