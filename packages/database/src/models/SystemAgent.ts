import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";

export interface SystemAgentAttributes {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  instructions: string;
  modelSlug: string;
  toolConfig: Record<string, unknown> | null;
  /** Constant user identity for this system agent — scopes its memory and context. */
  userId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

type SystemAgentCreationAttributes = Optional<SystemAgentAttributes, "id" | "createdAt" | "updatedAt" | "description" | "toolConfig" | "userId">;

class SystemAgent
  extends Model<SystemAgentAttributes, SystemAgentCreationAttributes>
  implements SystemAgentAttributes
{
  declare id: number;
  declare slug: string;
  declare name: string;
  declare description: string | null;
  declare instructions: string;
  declare modelSlug: string;
  declare toolConfig: Record<string, unknown> | null;
  declare userId: number | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

SystemAgent.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    slug: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    instructions: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    modelSlug: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "gpt-4o",
      field: "model_slug",
    },
    toolConfig: {
      type: DataTypes.JSONB,
      allowNull: true,
      field: "tool_config",
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "user_id",
      references: { model: "users", key: "id" },
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
    tableName: "system_agents",
    underscored: true,
    timestamps: true,
  },
);

export { SystemAgent };
