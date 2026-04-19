import { Router } from "express";
import { ModelsController } from "../../controllers/admin/models.controller";

const router = Router();
const modelsController = new ModelsController();

// Models and vendors are platform-wide catalogs (no `organizationId`). Vendor
// API keys are cross-tenant credentials. Mutations happen out-of-band via
// direct DB — see `mcpServers.controller.ts` for the pattern.
router.get("/models", modelsController.getAllModels);
router.get("/vendors", modelsController.getAllVendors);

export { router as modelsRouter };
