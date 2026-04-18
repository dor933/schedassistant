import { Notification } from "@scheduling-agent/database";
import type { NotificationType } from "@scheduling-agent/database/src/models/Notification";
import type { UserId } from "@scheduling-agent/types";
import { getIO } from "../sockets/server/socketServer";
import { logger } from "../logger";

export interface CreateNotificationInput {
  userId: UserId;
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: string | null;
  data?: Record<string, unknown> | null;
}

export class InAppNotificationsService {
  async create(input: CreateNotificationInput): Promise<Notification> {
    const row = await Notification.create({
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      data: input.data ?? null,
    });

    try {
      getIO().to(`user:${input.userId}`).emit("notification:new", this.toDTO(row));
    } catch (err) {
      logger.warn("InAppNotification socket emit failed", { error: String(err) });
    }

    return row;
  }

  async list(userId: UserId, limit = 30) {
    const rows = await Notification.findAll({
      where: { userId },
      order: [["createdAt", "DESC"]],
      limit,
    });
    return rows.map((r) => this.toDTO(r));
  }

  async unreadCount(userId: UserId): Promise<number> {
    return Notification.count({ where: { userId, readAt: null } });
  }

  async markRead(userId: UserId, id: string) {
    const row = await Notification.findOne({ where: { id, userId } });
    if (!row) {
      throw Object.assign(new Error("Notification not found"), { status: 404 });
    }
    if (row.readAt == null) {
      row.readAt = new Date();
      await row.save();
    }
    return this.toDTO(row);
  }

  async markAllRead(userId: UserId) {
    const [count] = await Notification.update(
      { readAt: new Date() },
      { where: { userId, readAt: null } },
    );
    return { updated: count };
  }

  private toDTO(row: Notification) {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      link: row.link,
      data: row.data,
      readAt: row.readAt,
      createdAt: row.createdAt,
    };
  }
}
