import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { ToolAttributes } from "@scheduling-agent/types";

type ToolCreationAttributes = Optional<ToolAttributes, "id" | "description" | "category" | "createdAt" | "updatedAt">;

class Tool extends Model<ToolAttributes, ToolCreationAttributes> implements ToolAttributes {
  declare id: number;
  declare name: string;
  declare slug: string;
  declare description: string | null;
  declare category: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

Tool.init(
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
    slug: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    category: {
      type: DataTypes.STRING,
      allowNull: true,
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
    tableName: "tools",
    underscored: true,
    timestamps: true,
  },
);

export { Tool };
