import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { SingleChatAttributes } from "@scheduling-agent/types";

type SingleChatCreationAttributes = Optional<
  SingleChatAttributes,
  "id" | "createdAt" | "updatedAt" | "title" | "modelId"
>;

class SingleChat
  extends Model<SingleChatAttributes, SingleChatCreationAttributes>
  implements SingleChatAttributes
{
  declare id: string;
  declare userId: string;
  declare agentId: string;
  declare modelId: string | null;
  declare title: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

SingleChat.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "user_id",
      references: { model: "users", key: "id" },
    },
    agentId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "agent_id",
      references: { model: "agents", key: "id" },
    },
    modelId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "model_id",
      references: { model: "models", key: "id" },
    },
    title: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "created_at",
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "updated_at",
    },
  },
  {
    sequelize,
    tableName: "single_chats",
    underscored: true,
    timestamps: true,
    indexes: [
      { fields: ["user_id"] },
      { fields: ["agent_id"] },
      { unique: true, fields: ["user_id", "agent_id"] },
    ],
  },
);

export { SingleChat };
