import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { AgentId } from "@scheduling-agent/types";

interface AgentMcpServerAttributes {
  id: number;
  agentId: AgentId;
  mcpServerId: number;
  createdAt: Date;
}

type AgentMcpServerCreationAttributes = Optional<AgentMcpServerAttributes, "id" | "createdAt">;

class AgentMcpServer
  extends Model<AgentMcpServerAttributes, AgentMcpServerCreationAttributes>
  implements AgentMcpServerAttributes
{
  declare id: number;
  declare agentId: AgentId;
  declare mcpServerId: number;
  declare createdAt: Date;
}

AgentMcpServer.init(
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
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "created_at",
    },
  },
  {
    sequelize,
    tableName: "agents_mcp_servers",
    underscored: true,
    timestamps: true,
    updatedAt: false,
  },
);

export { AgentMcpServer };
