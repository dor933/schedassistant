import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { UserAttributes, UserIdentity } from "@scheduling-agent/types";

type UserCreationAttributes = Optional<
  UserAttributes,
  | "createdAt"
  | "updatedAt"
  | "externalRef"
  | "displayName"
  | "userIdentity"
  | "password"
  | "userName"
  | "roleId"
>;

class User
  extends Model<UserAttributes, UserCreationAttributes>
  implements UserAttributes
{
  declare id: number;
  declare userName: string;
  declare externalRef: string | null;
  declare displayName: string | null;
  declare userIdentity: UserIdentity | null;
  declare password: string | null;
  declare roleId: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

User.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      allowNull: false,
      // `id` IS `persons.id` — no auto-increment; the caller must provide it
      // (typically by creating the Person row first and reusing its id).
      references: { model: "persons", key: "id" },
    },
    userName: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      field: "user_name",
    },
    externalRef: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: true,
      field: "external_ref",
    },
    displayName: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "display_name",
    },
    userIdentity: {
      type: DataTypes.JSONB,
      allowNull: true,
      field: "user_identity",
    },
    password: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    roleId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "role_id",
      references: { model: "roles", key: "id" },
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
    tableName: "users",
    underscored: true,
    timestamps: true,
  },
);

export { User };
