import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { AgentAttributes, OngoingRequest } from "@scheduling-agent/types";

type AgentCreationAttributes = Optional<
  AgentAttributes,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "definition"
  | "coreInstructions"
  | "characteristics"
  | "ongoingRequests"
  | "activeThreadId"
>;

class Agent extends Model<AgentAttributes, AgentCreationAttributes> implements AgentAttributes {
  declare id: string;
  declare definition: string | null;
  declare coreInstructions: string | null;
  declare characteristics: Record<string, unknown> | null;
  declare ongoingRequests: OngoingRequest[] | null;
  declare activeThreadId: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

Agent.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    definition: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    coreInstructions: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "core_instructions",
    },
    characteristics: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    ongoingRequests: {
      type: DataTypes.JSONB,
      allowNull: true,
      field: "ongoing_requests",
    },
    activeThreadId: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "active_thread_id",
      references: { model: "threads", key: "id" },
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
    tableName: "agents",
    underscored: true,
    timestamps: true,
  },
);

export { Agent };
