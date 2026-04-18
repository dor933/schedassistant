import { Router } from "express";
import { CronJobsController } from "../../controllers/admin/cronJobs.controller";

const controller = new CronJobsController();

/** Nested under /admin/agents/:agentId/cron-jobs for listing + creation. */
export const agentCronJobsRouter = Router({ mergeParams: true });
agentCronJobsRouter.get("/", controller.listForAgent);
agentCronJobsRouter.post("/", controller.create);

/** Flat routes under /admin/cron-jobs for update + delete by id. */
export const cronJobsRouter = Router();
cronJobsRouter.patch("/:id", controller.update);
cronJobsRouter.delete("/:id", controller.delete);
