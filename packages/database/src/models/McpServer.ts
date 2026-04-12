import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { McpServerAttributes } from "@scheduling-agent/types";

type McpServerCreationAttributes = Optional<McpServerAttributes, "id" | "createdAt" | "updatedAt" | "env" | "primaryAgentAssignable" | "systemAgentAssignable">;

class McpServer extends Model<McpServerAttributes, McpServerCreationAttributes> implements McpServerAttributes {
  declare id: number;
  declare name: string;
  declare transport: string;
  declare command: string;
  declare args: string[];
  declare env: Record<string, string> | null;
  declare primaryAgentAssignable: boolean;
  declare systemAgentAssignable: boolean;
  declare createdAt: Date;
  declare updatedAt: Date;
}

McpServer.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    transport: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "stdio",
    },
    command: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    args: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    env: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    primaryAgentAssignable: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      field: "primary_agent_assignable",
    },
    systemAgentAssignable: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      field: "system_agent_assignable",
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
    tableName: "mcp_servers",
    underscored: true,
    timestamps: true,
  },
);

export { McpServer };
