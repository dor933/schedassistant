import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { AgentId, UserId } from "@scheduling-agent/types";

export interface DeepAgentDelegationAttributes {
  id: string;
  callerAgentId: AgentId;
  systemAgentId: number;
  userId: UserId;
  request: string;
  result: string | null;
  status: "pending" | "running" | "completed" | "failed";
  groupId: string | null;
  singleChatId: string | null;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

type CreationAttrs = Optional<
  DeepAgentDelegationAttributes,
  "id" | "createdAt" | "result" | "completedAt" | "error"
>;

class DeepAgentDelegation
  extends Model<DeepAgentDelegationAttributes, CreationAttrs>
  implements DeepAgentDelegationAttributes
{
  declare id: string;
  declare callerAgentId: AgentId;
  declare systemAgentId: number;
  declare userId: UserId;
  declare request: string;
  declare result: string | null;
  declare status: "pending" | "running" | "completed" | "failed";
  declare groupId: string | null;
  declare singleChatId: string | null;
  declare error: string | null;
  declare createdAt: Date;
  declare completedAt: Date | null;
}

DeepAgentDelegation.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    callerAgentId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "caller_agent_id",
    },
    systemAgentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "system_agent_id",
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "user_id",
    },
    request: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    result: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "pending",
    },
    groupId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "group_id",
    },
    singleChatId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "single_chat_id",
    },
    error: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "created_at",
    },
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "completed_at",
    },
  },
  {
    sequelize,
    tableName: "deep_agent_delegations",
    underscored: true,
    timestamps: false,
  },
);

export { DeepAgentDelegation };
