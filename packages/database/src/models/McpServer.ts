import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { McpServerAttributes, OrganizationId } from "@scheduling-agent/types";

type McpServerCreationAttributes = Optional<
  McpServerAttributes,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "env"
  | "organizationId"
  | "description"
  | "scriptContent"
>;

class McpServer
  extends Model<McpServerAttributes, McpServerCreationAttributes>
  implements McpServerAttributes
{
  declare id: number;
  declare organizationId: OrganizationId | null;
  declare name: string;
  declare description: string | null;
  declare transport: string;
  declare command: string;
  declare args: string[];
  declare env: Record<string, string> | null;
  declare scriptContent: string | null;
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
    organizationId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "organization_id",
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
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
    scriptContent: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "script_content",
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
