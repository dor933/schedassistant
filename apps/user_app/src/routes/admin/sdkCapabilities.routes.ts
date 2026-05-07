import { Router } from "express";
import { SdkCapabilitiesController } from "../../controllers/admin/sdkCapabilities.controller";

const router = Router();
const controller = new SdkCapabilitiesController();

router.get("/", controller.getAll);

export { router as sdkCapabilitiesRouter };
