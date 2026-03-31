import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { GroupMemberAttributes } from "@scheduling-agent/types";

type GroupMemberCreationAttributes = Optional<
  GroupMemberAttributes,
  "id" | "createdAt"
>;

class GroupMember
  extends Model<GroupMemberAttributes, GroupMemberCreationAttributes>
  implements GroupMemberAttributes
{
  declare id: string;
  declare groupId: string;
  declare userId: number;
  declare createdAt: Date;
}

GroupMember.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    groupId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "group_id",
      references: { model: "groups", key: "id" },
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "user_id",
      references: { model: "users", key: "id" },
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "created_at",
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: "group_members",
    underscored: true,
    timestamps: false,
    indexes: [
      { unique: true, fields: ["group_id", "user_id"] },
      { fields: ["group_id"] },
      { fields: ["user_id"] },
    ],
  },
);

export { GroupMember };
