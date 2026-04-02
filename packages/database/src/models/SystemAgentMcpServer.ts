import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";

interface SystemAgentMcpServerAttributes {
  id: number;
  systemAgentId: number;
  mcpServerId: number;
  createdAt: Date;
}

type CreationAttrs = Optional<SystemAgentMcpServerAttributes, "id" | "createdAt">;

class SystemAgentMcpServer
  extends Model<SystemAgentMcpServerAttributes, CreationAttrs>
  implements SystemAgentMcpServerAttributes
{
  declare id: number;
  declare systemAgentId: number;
  declare mcpServerId: number;
  declare createdAt: Date;
}

SystemAgentMcpServer.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    systemAgentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "system_agent_id",
      references: { model: "system_agents", key: "id" },
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
    tableName: "system_agents_mcp_servers",
    underscored: true,
    timestamps: true,
    updatedAt: false,
  },
);

export { SystemAgentMcpServer };
