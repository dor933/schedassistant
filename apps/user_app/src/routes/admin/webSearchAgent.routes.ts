import { Router } from "express";
import { WebSearchAgentController } from "../../controllers/admin/webSearchAgent.controller";

const router = Router();
const controller = new WebSearchAgentController();

router.get("/", controller.get);
router.patch("/", controller.set);

export { router as webSearchAgentRouter };
