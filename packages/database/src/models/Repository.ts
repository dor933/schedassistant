import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { RepositoryAttributes, ProjectId } from "@scheduling-agent/types";

type RepositoryCreationAttributes = Optional<
  RepositoryAttributes,
  "id" | "createdAt" | "updatedAt" | "defaultBranch" | "metadata" | "architectureOverview" | "localPath" | "setupInstructions"
>;

class Repository extends Model<RepositoryAttributes, RepositoryCreationAttributes> implements RepositoryAttributes {
  declare id: string;
  declare projectId: ProjectId;
  declare name: string;
  declare url: string;
  declare defaultBranch: string;
  declare architectureOverview: string | null;
  declare localPath: string | null;
  declare setupInstructions: string | null;
  declare metadata: Record<string, unknown> | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

Repository.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    projectId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "project_id",
      references: { model: "projects", key: "id" },
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    url: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    defaultBranch: {
      type: DataTypes.STRING(255),
      allowNull: false,
      defaultValue: "main",
      field: "default_branch",
    },
    architectureOverview: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "architecture_overview",
    },
    localPath: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "local_path",
    },
    setupInstructions: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "setup_instructions",
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
    tableName: "repositories",
    underscored: true,
    timestamps: true,
  },
);

import { Project } from "./Project";

Repository.belongsTo(Project, { foreignKey: "projectId", as: "project" });

export { Repository };
