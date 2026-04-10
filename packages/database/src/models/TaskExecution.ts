import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { TaskExecutionAttributes, TaskExecutionStatus, AgentTaskId } from "@scheduling-agent/types";

type TaskExecutionCreationAttributes = Optional<
  TaskExecutionAttributes,
  "id" | "createdAt" | "status" | "cliSessionId" | "prompt" | "result" | "error" | "feedback" | "metadata" | "completedAt"
>;

class TaskExecution
  extends Model<TaskExecutionAttributes, TaskExecutionCreationAttributes>
  implements TaskExecutionAttributes
{
  declare id: string;
  declare agentTaskId: AgentTaskId;
  declare attemptNumber: number;
  declare status: TaskExecutionStatus;
  declare cliSessionId: string | null;
  declare prompt: string | null;
  declare result: string | null;
  declare error: string | null;
  declare feedback: string | null;
  declare metadata: Record<string, unknown> | null;
  declare createdAt: Date;
  declare completedAt: Date | null;
}

TaskExecution.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    agentTaskId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "agent_task_id",
      references: { model: "agent_tasks", key: "id" },
    },
    attemptNumber: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "attempt_number",
    },
    status: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: "running",
    },
    cliSessionId: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: "cli_session_id",
    },
    prompt: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    result: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    error: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    feedback: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: "created_at",
    },
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "completed_at",
    },
  },
  {
    sequelize,
    tableName: "task_executions",
    underscored: true,
    timestamps: false,
  },
);

import { AgentTask } from "./AgentTask";

TaskExecution.belongsTo(AgentTask, { foreignKey: "agentTaskId", as: "agentTask" });

export { TaskExecution };
