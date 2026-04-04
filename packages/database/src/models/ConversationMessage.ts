import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { ConversationMessageAttributes } from "@scheduling-agent/types";

type ConversationMessageCreationAttributes = Optional<
  ConversationMessageAttributes,
  "id" | "createdAt" | "senderName" | "requestId" | "modelSlug" | "vendorSlug" | "modelName"
>;

class ConversationMessage
  extends Model<ConversationMessageAttributes, ConversationMessageCreationAttributes>
  implements ConversationMessageAttributes
{
  declare id: string;
  declare groupId: string | null;
  declare singleChatId: string | null;
  declare threadId: string;
  declare role: "user" | "assistant";
  declare content: string;
  declare senderName: string | null;
  declare requestId: string | null;
  declare modelSlug: string | null;
  declare vendorSlug: string | null;
  declare modelName: string | null;
  declare createdAt: Date;
}

ConversationMessage.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    groupId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "group_id",
      references: { model: "groups", key: "id" },
    },
    singleChatId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "single_chat_id",
      references: { model: "single_chats", key: "id" },
    },
    threadId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "thread_id",
    },
    role: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    senderName: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "sender_name",
    },
    requestId: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: "request_id",
    },
    modelSlug: {
      type: DataTypes.STRING(128),
      allowNull: true,
      field: "model_slug",
    },
    vendorSlug: {
      type: DataTypes.STRING(128),
      allowNull: true,
      field: "vendor_slug",
    },
    modelName: {
      type: DataTypes.STRING(128),
      allowNull: true,
      field: "model_name",
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "created_at",
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: "conversation_messages",
    underscored: true,
    timestamps: false,
    indexes: [
      { fields: ["group_id", "created_at"] },
      { fields: ["single_chat_id", "created_at"] },
      { fields: ["thread_id"] },
    ],
  },
);

export { ConversationMessage };
