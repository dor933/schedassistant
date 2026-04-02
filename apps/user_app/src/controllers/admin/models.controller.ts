import { Request, Response } from "express";
import { ModelsService } from "../../services/admin/models.service";
import { logger } from "../../logger";

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

  createModel = async (req: Request, res: Response) => {
    const { vendorId, name, slug } = req.body;
    if (!vendorId || !name || !slug) return res.status(400).json({ error: "vendorId, name, and slug are required." });
    try {
      const result = await this.modelsService.createModel(vendorId, name, slug, req.user!.userId);
      return res.status(201).json(result);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("POST /models error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  deleteModel = async (req: Request, res: Response) => {
    try {
      const result = await this.modelsService.deleteModel(req.params.id as string, req.user!.userId);
      return res.json(result);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("DELETE /models/:id error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  setVendorApiKey = async (req: Request, res: Response) => {
    if (req.body.apiKey !== undefined && typeof req.body.apiKey !== "string") {
      return res.status(400).json({ error: "apiKey must be a string." });
    }
    try {
      const result = await this.modelsService.setVendorApiKey(req.params.id as string, req.body.apiKey, req.user!.userId);
      return res.json(result);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("PATCH /vendors/:id/api-key error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

}
