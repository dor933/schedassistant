import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { EpicTaskAttributes, EpicTaskStatus, ProjectId, UserId, AgentId } from "@scheduling-agent/types";

type EpicTaskCreationAttributes = Optional<
  EpicTaskAttributes,
  "id" | "createdAt" | "updatedAt" | "status" | "metadata" | "completedAt"
>;

class EpicTask extends Model<EpicTaskAttributes, EpicTaskCreationAttributes> implements EpicTaskAttributes {
  declare id: string;
  declare title: string;
  declare description: string;
  declare status: EpicTaskStatus;
  declare projectId: ProjectId;
  declare userId: UserId;
  declare agentId: AgentId;
  declare metadata: Record<string, unknown> | null;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare completedAt: Date | null;
}

EpicTask.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: "pending",
    },
    projectId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "project_id",
      references: { model: "projects", key: "id" },
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "user_id",
      references: { model: "users", key: "id" },
    },
    agentId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "agent_id",
      references: { model: "agents", key: "id" },
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
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "completed_at",
    },
  },
  {
    sequelize,
    tableName: "epic_tasks",
    underscored: true,
    timestamps: true,
  },
);

import { Project } from "./Project";
import { User } from "./User";
import { Agent } from "./Agent";
import { Repository } from "./Repository";
import { EpicTaskRepository } from "./EpicTaskRepository";
import { TaskStage } from "./TaskStage";

EpicTask.belongsTo(Project, { foreignKey: "projectId", as: "project" });
EpicTask.belongsTo(User, { foreignKey: "userId", as: "user" });
EpicTask.belongsTo(Agent, { foreignKey: "agentId", as: "agent" });
EpicTask.belongsToMany(Repository, { through: EpicTaskRepository, foreignKey: "epicTaskId", otherKey: "repositoryId", as: "repositories" });
EpicTask.hasMany(TaskStage, { foreignKey: "epicTaskId", as: "stages" });

export { EpicTask };
