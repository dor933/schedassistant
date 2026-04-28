import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { ApplicationAgentThreadAttributes } from "@scheduling-agent/types";

type ApplicationAgentThreadCreationAttributes = Optional<
  ApplicationAgentThreadAttributes,
  "id" | "createdAt" | "lastUsedAt"
>;

class ApplicationAgentThread
  extends Model<
    ApplicationAgentThreadAttributes,
    ApplicationAgentThreadCreationAttributes
  >
  implements ApplicationAgentThreadAttributes
{
  declare id: string;
  declare userId: number;
  declare applicationAgentId: string;
  declare threadId: string;
  declare createdAt: Date;
  declare lastUsedAt: Date;
}

ApplicationAgentThread.init(
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
    applicationAgentId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "application_agent_id",
      references: { model: "agents", key: "id" },
    },
    threadId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "thread_id",
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "created_at",
    },
    lastUsedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "last_used_at",
    },
  },
  {
    sequelize,
    tableName: "application_agent_threads",
    underscored: true,
    timestamps: false,
  },
);

export { ApplicationAgentThread };
