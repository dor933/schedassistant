import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { AgentId } from "@scheduling-agent/types";
import { Agent } from "./Agent";

export interface RoundtableMessageAttributes {
  id: string;
  roundtableId: string;
  agentId: AgentId;
  roundNumber: number;
  content: string;
  createdAt: Date;
}

type CreationAttrs = Optional<RoundtableMessageAttributes, "id" | "createdAt">;

class RoundtableMessage
  extends Model<RoundtableMessageAttributes, CreationAttrs>
  implements RoundtableMessageAttributes
{
  declare id: string;
  declare roundtableId: string;
  declare agentId: AgentId;
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
      allowNull: false,
      field: "agent_id",
      references: { model: "agents", key: "id" },
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

export { RoundtableMessage };
