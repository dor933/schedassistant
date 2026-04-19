import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";

export interface PlatformAdminAttributes {
  id: string;
  email: string;
  passwordHash: string;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type PlatformAdminCreationAttributes = Optional<
  PlatformAdminAttributes,
  "id" | "lastLoginAt" | "createdAt" | "updatedAt"
>;

class PlatformAdmin
  extends Model<PlatformAdminAttributes, PlatformAdminCreationAttributes>
  implements PlatformAdminAttributes
{
  declare id: string;
  declare email: string;
  declare passwordHash: string;
  declare lastLoginAt: Date | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

PlatformAdmin.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    passwordHash: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "password_hash",
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
    tableName: "platform_admins",
    underscored: true,
    timestamps: true,
  },
);

export { PlatformAdmin };
