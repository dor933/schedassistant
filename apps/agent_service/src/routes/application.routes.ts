import { Router } from "express";
import { ApplicationController } from "../controllers/application.controller";
import { handleAskGrahamy } from "../askGrahamy/http";

const router = Router();
const controller = new ApplicationController();

router.post("/ask-grahamy", handleAskGrahamy);
router.post("/:agentId/invoke", controller.invoke);

export { router as applicationRouter };
