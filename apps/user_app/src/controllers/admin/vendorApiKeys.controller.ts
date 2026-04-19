import { Request, Response } from "express";
import { VendorApiKeysService } from "../../services/admin/vendorApiKeys.service";
import { logger } from "../../logger";

/**
 * Org-scoped vendor API keys. The organizationId is ALWAYS read from the
 * caller's auth token — never a route param or body — so one org's super
 * admin can never touch another org's keys.
 */
export class VendorApiKeysController {
  private service = new VendorApiKeysService();

  list = async (req: Request, res: Response) => {
    try {
      const orgId = req.user!.organizationId;
      return res.json(await this.service.list(orgId));
    } catch (err: any) {
      if (err?.status) return res.status(err.status).json({ error: err.message });
      logger.error("GET /admin/vendor-api-keys error", { error: err?.message });
      return res.status(500).json({ error: "Internal server error." });
    }
  };

  set = async (req: Request, res: Response) => {
    const vendorId = req.params.vendorId;
    if (typeof vendorId !== "string" || !vendorId) {
      return res.status(400).json({ error: "vendorId is required." });
    }
    const { apiKey } = req.body ?? {};
    if (typeof apiKey !== "string") {
      return res.status(400).json({ error: "apiKey must be a string." });
    }
    try {
      const orgId = req.user!.organizationId;
      const result = await this.service.set(orgId, vendorId, apiKey, req.user!.userId);
      return res.json(result);
    } catch (err: any) {
      if (err?.status) return res.status(err.status).json({ error: err.message });
      logger.error("PUT /admin/vendor-api-keys/:vendorId error", { error: err?.message });
      return res.status(500).json({ error: "Internal server error." });
    }
  };

  remove = async (req: Request, res: Response) => {
    const vendorId = req.params.vendorId;
    if (typeof vendorId !== "string" || !vendorId) {
      return res.status(400).json({ error: "vendorId is required." });
    }
    try {
      const orgId = req.user!.organizationId;
      const result = await this.service.remove(orgId, vendorId, req.user!.userId);
      return res.json(result);
    } catch (err: any) {
      if (err?.status) return res.status(err.status).json({ error: err.message });
      logger.error("DELETE /admin/vendor-api-keys/:vendorId error", { error: err?.message });
      return res.status(500).json({ error: "Internal server error." });
    }
  };
}
