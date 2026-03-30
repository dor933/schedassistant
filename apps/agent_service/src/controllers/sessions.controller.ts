import { Request, Response } from "express";
import { SessionsService } from "../services/sessions.service";
import { logger } from "../logger";

const sessionsService = new SessionsService();

export class SessionsController {
  getSessions = async (req: Request, res: Response) => {
    try {
      const sessions = await sessionsService.getSessions(req.params.userId as string, {
        groupId: req.query.groupId as string | undefined,
        singleChatId: req.query.singleChatId as string | undefined,
      });
      return res.json(sessions);
    } catch (err: any) {
      logger.error("/api/sessions/:userId error", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  };

  createSession = async (req: Request, res: Response) => {
    const { userId, title, groupId, singleChatId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId is required." });
    }
    if (!groupId && !singleChatId) {
      return res
        .status(400)
        .json({ error: "groupId or singleChatId is required." });
    }

    try {
      const result = await sessionsService.createSession({ userId, title, groupId, singleChatId });
      return res.status(201).json(result);
    } catch (err: any) {
      logger.error("POST /api/sessions error", { error: err.message });
      const status = typeof err.status === "number" ? err.status : 500;
      return res.status(status).json({ error: err.message ?? "Internal error" });
    }
  };
}
