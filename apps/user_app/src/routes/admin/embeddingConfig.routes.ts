import { Router } from "express";
import { EmbeddingConfigController } from "../../controllers/admin/embeddingConfig.controller";
import { requireSuperAdmin } from "../../middlewares/requireSuperAdmin";

const router = Router();
const controller = new EmbeddingConfigController();

// Catalog is read-only; reading it is gated to super_admin to match the
// rest of the embedding admin surface (regular admins don't pick the
// embedding model — only super_admins do).
router.get("/catalog", requireSuperAdmin, controller.listCatalog);
router.get("/", requireSuperAdmin, controller.getOrgChoice);
router.put("/", requireSuperAdmin, controller.setOrgChoice);

export { router as embeddingConfigRouter };
