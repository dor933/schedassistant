import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { EpicTaskRepositoryAttributes, EpicTaskId, RepositoryId } from "@scheduling-agent/types";

type EpicTaskRepositoryCreationAttributes = Optional<
  EpicTaskRepositoryAttributes,
  "id" | "createdAt"
>;

class EpicTaskRepository
  extends Model<EpicTaskRepositoryAttributes, EpicTaskRepositoryCreationAttributes>
  implements EpicTaskRepositoryAttributes
{
  declare id: string;
  declare epicTaskId: EpicTaskId;
  declare repositoryId: RepositoryId;
  declare createdAt: Date;
}

EpicTaskRepository.init(
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
    repositoryId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "repository_id",
      references: { model: "repositories", key: "id" },
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
    tableName: "epic_task_repositories",
    underscored: true,
    timestamps: false,
  },
);

export { EpicTaskRepository };
