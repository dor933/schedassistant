import { Router } from "express";
import { ApplicationController } from "../controllers/application.controller";

const router = Router();
const controller = new ApplicationController();

router.post("/:agentId/invoke", controller.invoke);

export { router as applicationRouter };
