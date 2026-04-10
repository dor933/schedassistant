import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { AgentTaskAttributes, AgentTaskStatus, TaskStageId } from "@scheduling-agent/types";

type AgentTaskCreationAttributes = Optional<
  AgentTaskAttributes,
  "id" | "createdAt" | "updatedAt" | "status" | "description" | "sortOrder" | "metadata" | "startedAt" | "completedAt"
>;

class AgentTask extends Model<AgentTaskAttributes, AgentTaskCreationAttributes> implements AgentTaskAttributes {
  declare id: string;
  declare taskStageId: TaskStageId;
  declare title: string;
  declare description: string | null;
  declare status: AgentTaskStatus;
  declare sortOrder: number;
  declare metadata: Record<string, unknown> | null;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare startedAt: Date | null;
  declare completedAt: Date | null;
}

AgentTask.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    taskStageId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "task_stage_id",
      references: { model: "task_stages", key: "id" },
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
    startedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "started_at",
    },
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "completed_at",
    },
  },
  {
    sequelize,
    tableName: "agent_tasks",
    underscored: true,
    timestamps: true,
  },
);

import { TaskStage } from "./TaskStage";
import { TaskExecution } from "./TaskExecution";
import { TaskDependency } from "./TaskDependency";

AgentTask.belongsTo(TaskStage, { foreignKey: "taskStageId", as: "stage" });
AgentTask.hasMany(TaskExecution, { foreignKey: "agentTaskId", as: "executions" });
AgentTask.belongsToMany(AgentTask, {
  through: TaskDependency,
  as: "dependencies",
  foreignKey: "taskId",
  otherKey: "dependsOnTaskId",
});
AgentTask.belongsToMany(AgentTask, {
  through: TaskDependency,
  as: "dependents",
  foreignKey: "dependsOnTaskId",
  otherKey: "taskId",
});

export { AgentTask };
