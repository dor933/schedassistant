import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { ProjectAttributes, UserId } from "@scheduling-agent/types";

type ProjectCreationAttributes = Optional<
  ProjectAttributes,
  "id" | "createdAt" | "updatedAt" | "description" | "metadata" | "architectureOverview" | "techStack"
>;

class Project extends Model<ProjectAttributes, ProjectCreationAttributes> implements ProjectAttributes {
  declare id: string;
  declare name: string;
  declare description: string | null;
  declare userId: UserId;
  declare architectureOverview: string | null;
  declare techStack: string | null;
  declare metadata: Record<string, unknown> | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

Project.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    architectureOverview: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "architecture_overview",
    },
    techStack: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "tech_stack",
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "user_id",
      references: { model: "users", key: "id" },
    },
    metadata: {
      type: DataTypes.JSONB,
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
    tableName: "projects",
    underscored: true,
    timestamps: true,
  },
);

import { Repository } from "./Repository";
import { EpicTask } from "./EpicTask";

Project.hasMany(Repository, { foreignKey: "projectId", as: "repositories" });
Project.hasMany(EpicTask, { foreignKey: "projectId", as: "epicTasks" });

export { Project };
