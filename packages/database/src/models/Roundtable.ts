import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { UserId } from "@scheduling-agent/types";

export type RoundtableStatus =
  | "pending"
  | "running"
  | "waiting_for_user"
  | "completed"
  | "failed";

export interface RoundtableAttributes {
  id: string;
  topic: string;
  status: RoundtableStatus;
  maxTurnsPerAgent: number;
  currentRound: number;
  currentAgentOrderIndex: number;
  /** When true, the creating user is a participant and gets the last turn of each round. */
  includeUser: boolean;
  groupId: string | null;
  singleChatId: string | null;
  threadId: string;
  createdBy: UserId;
  /** Final roundtable summary — written once when status transitions to "completed". */
  summary: string | null;
  summaryGeneratedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type CreationAttrs = Optional<
  RoundtableAttributes,
  | "id"
  | "status"
  | "maxTurnsPerAgent"
  | "currentRound"
  | "currentAgentOrderIndex"
  | "includeUser"
  | "summary"
  | "summaryGeneratedAt"
  | "createdAt"
  | "updatedAt"
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
  declare includeUser: boolean;
  declare groupId: string | null;
  declare singleChatId: string | null;
  declare threadId: string;
  declare createdBy: UserId;
  declare summary: string | null;
  declare summaryGeneratedAt: Date | null;
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
    includeUser: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: "include_user",
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
    summary: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    summaryGeneratedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "summary_generated_at",
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
