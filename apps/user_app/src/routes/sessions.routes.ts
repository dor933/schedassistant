import { Router } from "express";
import { SessionsController } from "../controllers/sessions.controller";
import { authMiddleware } from "../middlewares/auth";

const router = Router();
const sessionsController = new SessionsController();

router.get("/", authMiddleware, sessionsController.getSessions);
router.post("/", authMiddleware, sessionsController.createSession);
router.get(
  "/history/conversation/:conversationType/:conversationId/search",
  authMiddleware,
  sessionsController.searchConversationHistory,
);
router.get("/history/conversation/:conversationType/:conversationId", authMiddleware, sessionsController.getConversationHistory);
router.delete("/single-chats/:id", authMiddleware, sessionsController.deleteSingleChat);

export { router as sessionsRouter };
