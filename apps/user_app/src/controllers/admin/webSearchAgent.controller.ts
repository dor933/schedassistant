import { Request, Response } from "express";
import { webSearchChoiceSchema } from "@scheduling-agent/types";
import { WebSearchAgentService } from "../../services/admin/webSearchAgent.service";
import { logger } from "../../logger";

export class WebSearchAgentController {
  private service = new WebSearchAgentService();

  get = async (req: Request, res: Response) => {
    try {
      const data = await this.service.get(req.user!.organizationId);
      return res.json(data);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("GET /admin/web-search-agent error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  set = async (req: Request, res: Response) => {
    const parsed = webSearchChoiceSchema.safeParse(req.body?.choice);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid choice. Expected 'gemini' or 'tavily'.",
      });
    }

    try {
      const data = await this.service.set(
        req.user!.organizationId,
        parsed.data,
        req.user!.id,
      );
      return res.json(data);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("PATCH /admin/web-search-agent error:", err);
      return res.status(500).json({ error: err.message });
    }
  };
}
