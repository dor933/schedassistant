import { Router } from "express";
import { InAppNotificationsController } from "../controllers/inAppNotifications.controller";
import { authMiddleware } from "../middlewares/auth";

const router = Router();
const controller = new InAppNotificationsController();

router.get("/", authMiddleware, controller.list);
router.post("/:id/read", authMiddleware, controller.markRead);
router.post("/read-all", authMiddleware, controller.markAllRead);

export { router as inAppNotificationsRouter };
