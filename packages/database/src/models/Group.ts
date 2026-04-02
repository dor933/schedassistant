import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { GroupAttributes } from "@scheduling-agent/types";

type GroupCreationAttributes = Optional<
  GroupAttributes,
  "id" | "createdAt" | "updatedAt"
>;

class Group
  extends Model<GroupAttributes, GroupCreationAttributes>
  implements GroupAttributes
{
  declare id: string;
  declare name: string;
  declare agentId: string;
  declare createdAt: Date;
  declare updatedAt: Date;
}

Group.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    agentId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "agent_id",
      references: { model: "agents", key: "id" },
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
    tableName: "groups",
    underscored: true,
    timestamps: true,
    indexes: [{ fields: ["name"] }],
  },
);

export { Group };
