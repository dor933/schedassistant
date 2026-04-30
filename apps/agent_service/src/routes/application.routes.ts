import { Router } from "express";
import { ApplicationController } from "../controllers/application.controller";
import { requireApplicationToken } from "../middleware/requireApplicationToken";

const router = Router();
const controller = new ApplicationController();

router.use(requireApplicationToken);
router.post("/:agentId/invoke", controller.invoke);

export { router as applicationRouter };
