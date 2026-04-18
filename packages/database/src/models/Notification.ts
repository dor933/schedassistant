import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { UserId } from "@scheduling-agent/types";

export type NotificationType =
  | "roundtable_invite"
  | "roundtable_turn"
  | "roundtable_completed";

export interface NotificationAttributes {
  id: string;
  userId: UserId;
  type: NotificationType;
  title: string;
  body: string | null;
  /** Optional deep link (e.g. "/roundtable/abc-123") */
  link: string | null;
  /** Arbitrary payload for the client (e.g. { roundtableId }) */
  data: Record<string, unknown> | null;
  readAt: Date | null;
  createdAt: Date;
}

type CreationAttrs = Optional<
  NotificationAttributes,
  "id" | "body" | "link" | "data" | "readAt" | "createdAt"
>;

class Notification
  extends Model<NotificationAttributes, CreationAttrs>
  implements NotificationAttributes
{
  declare id: string;
  declare userId: UserId;
  declare type: NotificationType;
  declare title: string;
  declare body: string | null;
  declare link: string | null;
  declare data: Record<string, unknown> | null;
  declare readAt: Date | null;
  declare createdAt: Date;
}

Notification.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "user_id",
      references: { model: "users", key: "id" },
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },
    body: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    link: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    readAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "read_at",
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "created_at",
    },
  },
  {
    sequelize,
    tableName: "notifications",
    underscored: true,
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ["user_id", "read_at"] },
      { fields: ["user_id", "created_at"] },
    ],
  },
);

export { Notification };
