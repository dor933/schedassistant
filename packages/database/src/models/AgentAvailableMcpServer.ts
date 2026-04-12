import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { AgentId } from "@scheduling-agent/types";

interface AgentAvailableMcpServerAttributes {
  id: number;
  agentId: AgentId;
  mcpServerId: number;
  active: boolean;
  createdAt: Date;
}

type CreationAttributes = Optional<AgentAvailableMcpServerAttributes, "id" | "active" | "createdAt">;

class AgentAvailableMcpServer
  extends Model<AgentAvailableMcpServerAttributes, CreationAttributes>
  implements AgentAvailableMcpServerAttributes
{
  declare id: number;
  declare agentId: AgentId;
  declare mcpServerId: number;
  declare active: boolean;
  declare createdAt: Date;
}

AgentAvailableMcpServer.init(
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
    mcpServerId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "mcp_server_id",
      references: { model: "mcp_servers", key: "id" },
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
    tableName: "agent_available_mcp_servers",
    underscored: true,
    timestamps: true,
    updatedAt: false,
  },
);

export { AgentAvailableMcpServer };
