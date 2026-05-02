import { Request, Response } from "express";
import { embeddingConfigService } from "../../services/admin/embeddingConfig.service";
import { logger } from "../../logger";

export class EmbeddingConfigController {
  /** Read-only catalog of supported embedding models. */
  listCatalog = async (_req: Request, res: Response) => {
    try {
      return res.json(await embeddingConfigService.listCatalog());
    } catch (err: any) {
      logger.error("GET /admin/embedding-config/catalog error", {
        error: err?.message,
      });
      return res.status(500).json({ error: "Internal server error." });
    }
  };

  /** Caller's org current choice + setup-status. */
  getOrgChoice = async (req: Request, res: Response) => {
    try {
      const orgId = req.user!.organizationId;
      return res.json(await embeddingConfigService.getOrgChoice(orgId));
    } catch (err: any) {
      if (err?.status) return res.status(err.status).json({ error: err.message });
      logger.error("GET /admin/embedding-config error", { error: err?.message });
      return res.status(500).json({ error: "Internal server error." });
    }
  };

  /** Set the caller's org's embedding model. Refuses dim-changing switches. */
  setOrgChoice = async (req: Request, res: Response) => {
    const { modelId } = req.body ?? {};
    if (typeof modelId !== "string" || !modelId) {
      return res.status(400).json({ error: "modelId is required." });
    }
    try {
      const orgId = req.user!.organizationId;
      return res.json(
        await embeddingConfigService.setOrgChoice(
          orgId,
          modelId,
          req.user!.userId,
        ),
      );
    } catch (err: any) {
      if (err?.status) return res.status(err.status).json({ error: err.message });
      logger.error("PUT /admin/embedding-config error", { error: err?.message });
      return res.status(500).json({ error: "Internal server error." });
    }
  };
}
