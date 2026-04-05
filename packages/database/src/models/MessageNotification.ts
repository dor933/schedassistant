import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type {
  MessageNotificationAttributes,
  NotificationStatus,
} from "@scheduling-agent/types";

type MessageNotificationCreationAttributes = Optional<
  MessageNotificationAttributes,
  "id" | "deliveredAt" | "seenAt" | "preview" | "senderId"
>;

class MessageNotification
  extends Model<MessageNotificationAttributes, MessageNotificationCreationAttributes>
  implements MessageNotificationAttributes
{
  declare id: string;
  declare threadId: string;
  declare recipientId: number;
  declare senderId: number | null;
  declare messageId: string;
  declare preview: string | null;
  declare status: NotificationStatus;
  declare conversationId: string;
  declare conversationType: "single";
  declare deliveredAt: Date;
  declare seenAt: Date | null;
}

MessageNotification.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    threadId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "thread_id",
    },
    recipientId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "recipient_id",
      references: { model: "users", key: "id" },
    },
    senderId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "sender_id",
      references: { model: "users", key: "id" },
    },
    messageId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "message_id",
    },
    preview: {
      type: DataTypes.STRING(300),
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM("delivered", "seen"),
      allowNull: false,
      defaultValue: "delivered",
    },
    conversationId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "conversation_id",
    },
    conversationType: {
      type: DataTypes.ENUM("single"),
      allowNull: false,
      field: "conversation_type",
    },
    deliveredAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "delivered_at",
      defaultValue: DataTypes.NOW,
    },
    seenAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "seen_at",
    },
  },
  {
    sequelize,
    tableName: "message_notifications",
    underscored: true,
    timestamps: false,
    indexes: [
      { fields: ["recipient_id", "status"] },
      { fields: ["recipient_id", "conversation_id"] },
      { fields: ["message_id"] },
      { fields: ["thread_id"] },
    ],
  },
);

export { MessageNotification };
