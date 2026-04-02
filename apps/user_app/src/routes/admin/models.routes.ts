import { Router } from "express";
import { ModelsController } from "../../controllers/admin/models.controller";

const router = Router();
const modelsController = new ModelsController();

router.get("/models", modelsController.getAllModels);
router.get("/vendors", modelsController.getAllVendors);
router.post("/models", modelsController.createModel);
router.delete("/models/:id", modelsController.deleteModel);
router.patch("/vendors/:id/api-key", modelsController.setVendorApiKey);

export { router as modelsRouter };
