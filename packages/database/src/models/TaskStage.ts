import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { TaskStageAttributes, TaskStageStatus, PrStatus, EpicTaskId, RepositoryId } from "@scheduling-agent/types";

type TaskStageCreationAttributes = Optional<
  TaskStageAttributes,
  "id" | "createdAt" | "updatedAt" | "status" | "description" | "sortOrder" | "prUrl" | "prNumber" | "prStatus" | "repositoryId" | "branchName" | "baseCommitSha" | "metadata" | "completedAt"
>;

class TaskStage extends Model<TaskStageAttributes, TaskStageCreationAttributes> implements TaskStageAttributes {
  declare id: string;
  declare epicTaskId: EpicTaskId;
  declare title: string;
  declare description: string | null;
  declare status: TaskStageStatus;
  declare sortOrder: number;
  declare prUrl: string | null;
  declare prNumber: number | null;
  declare prStatus: PrStatus | null;
  declare repositoryId: RepositoryId | null;
  declare branchName: string | null;
  declare baseCommitSha: string | null;
  declare metadata: Record<string, unknown> | null;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare completedAt: Date | null;
}

TaskStage.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    epicTaskId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "epic_task_id",
      references: { model: "epic_tasks", key: "id" },
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: "pending",
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: "sort_order",
    },
    prUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "pr_url",
    },
    prNumber: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "pr_number",
    },
    prStatus: {
      type: DataTypes.STRING(32),
      allowNull: true,
      field: "pr_status",
    },
    repositoryId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "repository_id",
      references: { model: "repositories", key: "id" },
    },
    branchName: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "branch_name",
    },
    baseCommitSha: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "base_commit_sha",
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
    tableName: "task_stages",
    underscored: true,
    timestamps: true,
  },
);

import { EpicTask } from "./EpicTask";
import { AgentTask } from "./AgentTask";
import { Repository } from "./Repository";

TaskStage.belongsTo(EpicTask, { foreignKey: "epicTaskId", as: "epicTask" });
TaskStage.belongsTo(Repository, { foreignKey: "repositoryId", as: "repository" });
TaskStage.hasMany(AgentTask, { foreignKey: "taskStageId", as: "tasks" });

export { TaskStage };
