import { Router } from "express";
import { HistoryController } from "../controllers/history.controller";

const router = Router();
const historyController = new HistoryController();

router.get(
  "/conversation/:conversationType/:conversationId/search",
  historyController.searchConversationHistory,
);
router.get("/conversation/:conversationType/:conversationId", historyController.getConversationHistory);

export { router as historyRouter };
