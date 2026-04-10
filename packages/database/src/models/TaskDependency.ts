import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { TaskDependencyAttributes, AgentTaskId } from "@scheduling-agent/types";

type TaskDependencyCreationAttributes = Optional<
  TaskDependencyAttributes,
  "id" | "createdAt"
>;

class TaskDependency
  extends Model<TaskDependencyAttributes, TaskDependencyCreationAttributes>
  implements TaskDependencyAttributes
{
  declare id: string;
  declare taskId: AgentTaskId;
  declare dependsOnTaskId: AgentTaskId;
  declare createdAt: Date;
}

TaskDependency.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    taskId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "task_id",
      references: { model: "agent_tasks", key: "id" },
    },
    dependsOnTaskId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "depends_on_task_id",
      references: { model: "agent_tasks", key: "id" },
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: "created_at",
    },
  },
  {
    sequelize,
    tableName: "task_dependencies",
    underscored: true,
    timestamps: false,
  },
);

export { TaskDependency };
