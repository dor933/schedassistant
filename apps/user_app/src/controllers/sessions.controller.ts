import { Request, Response } from "express";
import { SessionsService } from "../services/sessions.service";
import { logger } from "../logger";

export class SessionsController {
  private sessionsService = new SessionsService();

  getSessions = async (req: Request, res: Response) => {
    try {
      const data = await this.sessionsService.getSessions(
        req.user!.userId,
        req.query.singleChatId as string | undefined,
      );
      return res.json(data);
    } catch (err: any) {
      logger.error("Sessions proxy error", { error: err?.message });
      return res.status(502).json({ error: "Agent service unavailable." });
    }
  };

  createSession = async (req: Request, res: Response) => {
    try {
      const data = await this.sessionsService.createSession(
        req.user!.userId, req.body.title, req.body.singleChatId,
      );
      return res.status(201).json(data);
    } catch (err: any) {
      if (err.data) return res.status(err.status).json(err.data);
      logger.error("Sessions proxy error", { error: err?.message });
      return res.status(502).json({ error: "Agent service unavailable." });
    }
  };

  getConversationHistory = async (req: Request, res: Response) => {
    try {
      const data = await this.sessionsService.getConversationHistory(
        req.user!.userId,
        req.params.conversationType as string,
        req.params.conversationId as string,
        req.query.limit as string | undefined,
        req.query.offset as string | undefined,
      );
      return res.json(data);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("Conversation history proxy error", { error: err?.message });
      return res.status(502).json({ error: "Agent service unavailable." });
    }
  };

  searchConversationHistory = async (req: Request, res: Response) => {
    try {
      const data = await this.sessionsService.searchConversationHistory(
        req.user!.userId,
        req.params.conversationType as string,
        req.params.conversationId as string,
        req.query.q as string | undefined,
      );
      return res.json(data);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("Conversation search proxy error", { error: err?.message });
      return res.status(502).json({ error: "Agent service unavailable." });
    }
  };

  deleteSingleChat = async (req: Request, res: Response) => {
    try {
      const result = await this.sessionsService.deleteSingleChat(req.params.id as string, req.user!.userId);
      return res.json(result);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("DELETE /single-chats error", { error: err?.message });
      return res.status(500).json({ error: err.message });
    }
  };

}
