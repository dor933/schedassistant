import { Request, Response } from "express";
import { ModelsService } from "../../services/admin/models.service";
import { logger } from "../../logger";

/**
 * Read-only controller: models and vendors are platform-wide catalogs and
 * vendor API keys are cross-tenant credentials. Mutations happen out-of-band
 * via direct DB. See `mcpServers.controller.ts` for the pattern.
 */
export class ModelsController {
  private modelsService = new ModelsService();

  getAllModels = async (_req: Request, res: Response) => {
    try {
      const models = await this.modelsService.getAllModels();
      return res.json(models);
    } catch (err: any) {
      logger.error("GET /models error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  getAllVendors = async (_req: Request, res: Response) => {
    try {
      const vendors = await this.modelsService.getAllVendors();
      return res.json(vendors);
    } catch (err: any) {
      logger.error("GET /vendors error:", err);
      return res.status(500).json({ error: err.message });
    }
  };
}
