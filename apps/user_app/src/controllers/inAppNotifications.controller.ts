import { Request, Response } from "express";
import { InAppNotificationsService } from "../services/inAppNotifications.service";
import { logger } from "../logger";

export class InAppNotificationsController {
  private service = new InAppNotificationsService();

  list = async (req: Request, res: Response) => {
    try {
      const items = await this.service.list(req.user!.userId);
      const unreadCount = await this.service.unreadCount(req.user!.userId);
      return res.json({ items, unreadCount });
    } catch (err: any) {
      logger.error("Notifications list error", { error: err?.message });
      return res.status(500).json({ error: "Internal server error." });
    }
  };

  markRead = async (req: Request, res: Response) => {
    try {
      const dto = await this.service.markRead(
        req.user!.userId,
        req.params.id as string,
      );
      return res.json(dto);
    } catch (err: any) {
      logger.error("Notification markRead error", { error: err?.message });
      return res
        .status(err?.status ?? 500)
        .json({ error: err?.message ?? "Internal server error." });
    }
  };

  markAllRead = async (req: Request, res: Response) => {
    try {
      const result = await this.service.markAllRead(req.user!.userId);
      return res.json(result);
    } catch (err: any) {
      logger.error("Notification markAllRead error", { error: err?.message });
      return res.status(500).json({ error: "Internal server error." });
    }
  };
}
