import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { AuthProvider, UserAttributes, UserIdentity } from "@scheduling-agent/types";

type UserCreationAttributes = Optional<
  UserAttributes,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "externalRef"
  | "displayName"
  | "userIdentity"
  | "password"
  | "userName"
  | "roleId"
  | "organizationId"
  | "authProvider"
  | "externalSub"
  | "lastLoginAt"
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
  declare organizationId: string;
  declare authProvider: AuthProvider;
  declare externalSub: string | null;
  declare lastLoginAt: Date | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

User.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
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
    organizationId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "organization_id",
      references: { model: "organizations", key: "id" },
    },
    authProvider: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: "local",
      field: "auth_provider",
    },
    externalSub: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "external_sub",
    },
    lastLoginAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "last_login_at",
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
