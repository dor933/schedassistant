import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { AgentId, UserId } from "@scheduling-agent/types";
import { Agent } from "./Agent";
import { User } from "./User";

export interface RoundtableMessageAttributes {
  id: string;
  roundtableId: string;
  /** Agent author — null when this row is a user contribution. */
  agentId: AgentId | null;
  /** User author — null when this row is an agent contribution. Exactly one of agentId/userId is set. */
  userId: UserId | null;
  roundNumber: number;
  content: string;
  createdAt: Date;
}

type CreationAttrs = Optional<
  RoundtableMessageAttributes,
  "id" | "createdAt" | "agentId" | "userId"
>;

class RoundtableMessage
  extends Model<RoundtableMessageAttributes, CreationAttrs>
  implements RoundtableMessageAttributes
{
  declare id: string;
  declare roundtableId: string;
  declare agentId: AgentId | null;
  declare userId: UserId | null;
  declare roundNumber: number;
  declare content: string;
  declare createdAt: Date;
}

RoundtableMessage.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    roundtableId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "roundtable_id",
      references: { model: "roundtables", key: "id" },
    },
    agentId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "agent_id",
      references: { model: "agents", key: "id" },
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "user_id",
      references: { model: "users", key: "id" },
    },
    roundNumber: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "round_number",
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "created_at",
    },
  },
  {
    sequelize,
    tableName: "roundtable_messages",
    underscored: true,
    timestamps: true,
    updatedAt: false,
  },
);

RoundtableMessage.belongsTo(Agent, { foreignKey: "agentId", as: "agent" });
RoundtableMessage.belongsTo(User, { foreignKey: "userId", as: "user" });

export { RoundtableMessage };
