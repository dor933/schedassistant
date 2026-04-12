import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { AgentId } from "@scheduling-agent/types";

interface AgentAvailableToolAttributes {
  id: number;
  agentId: AgentId;
  toolId: number;
  active: boolean;
  createdAt: Date;
}

type CreationAttributes = Optional<AgentAvailableToolAttributes, "id" | "active" | "createdAt">;

class AgentAvailableTool
  extends Model<AgentAvailableToolAttributes, CreationAttributes>
  implements AgentAvailableToolAttributes
{
  declare id: number;
  declare agentId: AgentId;
  declare toolId: number;
  declare active: boolean;
  declare createdAt: Date;
}

AgentAvailableTool.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    agentId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "agent_id",
      references: { model: "agents", key: "id" },
    },
    toolId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "tool_id",
      references: { model: "tools", key: "id" },
    },
    active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "created_at",
    },
  },
  {
    sequelize,
    tableName: "agent_available_tools",
    underscored: true,
    timestamps: true,
    updatedAt: false,
  },
);

export { AgentAvailableTool };
