import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { UserId } from "@scheduling-agent/types";

export type RoundtableStatus = "pending" | "running" | "completed" | "failed";

export interface RoundtableAttributes {
  id: string;
  topic: string;
  status: RoundtableStatus;
  maxTurnsPerAgent: number;
  currentRound: number;
  currentAgentOrderIndex: number;
  groupId: string | null;
  singleChatId: string | null;
  threadId: string;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
}

type CreationAttrs = Optional<
  RoundtableAttributes,
  "id" | "status" | "maxTurnsPerAgent" | "currentRound" | "currentAgentOrderIndex" | "createdAt" | "updatedAt"
>;

class Roundtable
  extends Model<RoundtableAttributes, CreationAttrs>
  implements RoundtableAttributes
{
  declare id: string;
  declare topic: string;
  declare status: RoundtableStatus;
  declare maxTurnsPerAgent: number;
  declare currentRound: number;
  declare currentAgentOrderIndex: number;
  declare groupId: string | null;
  declare singleChatId: string | null;
  declare threadId: string;
  declare createdBy: UserId;
  declare createdAt: Date;
  declare updatedAt: Date;
}

Roundtable.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    topic: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "pending",
    },
    maxTurnsPerAgent: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 5,
      field: "max_turns_per_agent",
    },
    currentRound: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: "current_round",
    },
    currentAgentOrderIndex: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: "current_agent_order_index",
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
    threadId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "thread_id",
    },
    createdBy: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "created_by",
      references: { model: "users", key: "id" },
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
    tableName: "roundtables",
    underscored: true,
    timestamps: true,
  },
);

export { Roundtable };
