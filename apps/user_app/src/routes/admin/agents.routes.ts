import { Router } from "express";
import { AgentsController } from "../../controllers/admin/agents.controller";
import { agentCronJobsRouter } from "./cronJobs.routes";

const router = Router();
const agentsController = new AgentsController();

router.get("/", agentsController.getAll);
router.post("/", agentsController.create);
router.patch("/:id", agentsController.update);

router.use("/:agentId/cron-jobs", agentCronJobsRouter);

export { router as agentsRouter };
