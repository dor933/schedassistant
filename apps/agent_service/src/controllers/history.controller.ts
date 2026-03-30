import { Request, Response } from "express";
import { HistoryService } from "../services/history.service";
import { logger } from "../logger";

const historyService = new HistoryService();

export class HistoryController {
  getConversationHistory = async (req: Request, res: Response) => {
    const conversationType = req.params.conversationType as string;
    const conversationId = req.params.conversationId as string;
    if (conversationType !== "group" && conversationType !== "single") {
      return res.status(400).json({ error: "conversationType must be 'group' or 'single'" });
    }
    try {
      const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
      const offset = req.query.offset != null ? Number(req.query.offset) : undefined;
      const result = await historyService.getConversationHistory(
        conversationId, conversationType, { limit, offset },
      );
      return res.json(result);
    } catch (err: any) {
      logger.error("/api/history/conversation error", { conversationType, conversationId, error: err.message });
      return res.json({ messages: [], total: 0 });
    }
  };

  searchConversationHistory = async (req: Request, res: Response) => {
    const conversationType = req.params.conversationType as string;
    const conversationId = req.params.conversationId as string;
    const q = typeof req.query.q === "string" ? req.query.q : "";
    if (conversationType !== "group" && conversationType !== "single") {
      return res.status(400).json({ error: "conversationType must be 'group' or 'single'" });
    }
    try {
      const result = await historyService.searchConversationHistory(conversationId, conversationType, q);
      return res.json(result);
    } catch (err: any) {
      logger.error("/api/history/conversation/.../search error", { conversationType, conversationId, error: err.message });
      return res.json({ results: [], total: 0 });
    }
  };
}
