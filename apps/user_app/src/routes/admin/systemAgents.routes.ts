import { Router } from "express";
import { SystemAgentsController } from "../../controllers/admin/systemAgents.controller";

const router = Router();
const controller = new SystemAgentsController();

router.get("/", controller.getAll);
router.post("/", controller.create);
router.patch("/:id", controller.update);

export { router as systemAgentsRouter };
