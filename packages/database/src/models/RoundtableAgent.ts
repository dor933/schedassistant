import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { AgentId } from "@scheduling-agent/types";
import { Agent } from "./Agent";

export interface RoundtableAgentAttributes {
  id: string;
  roundtableId: string;
  agentId: AgentId;
  turnOrder: number;
  turnsCompleted: number;
  createdAt: Date;
}

type CreationAttrs = Optional<RoundtableAgentAttributes, "id" | "turnsCompleted" | "createdAt">;

class RoundtableAgent
  extends Model<RoundtableAgentAttributes, CreationAttrs>
  implements RoundtableAgentAttributes
{
  declare id: string;
  declare roundtableId: string;
  declare agentId: AgentId;
  declare turnOrder: number;
  declare turnsCompleted: number;
  declare createdAt: Date;
}

RoundtableAgent.init(
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
    turnOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "turn_order",
    },
    turnsCompleted: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: "turns_completed",
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "created_at",
    },
  },
  {
    sequelize,
    tableName: "roundtable_agents",
    underscored: true,
    timestamps: true,
    updatedAt: false,
  },
);

RoundtableAgent.belongsTo(Agent, { foreignKey: "agentId", as: "agent" });

export { RoundtableAgent };
