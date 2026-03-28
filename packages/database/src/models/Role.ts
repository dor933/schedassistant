import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";

export interface RoleAttributes {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

type RoleCreationAttributes = Optional<RoleAttributes, "id" | "createdAt" | "updatedAt">;

class Role extends Model<RoleAttributes, RoleCreationAttributes> implements RoleAttributes {
  declare id: string;
  declare name: string;
  declare createdAt: Date;
  declare updatedAt: Date;
}

Role.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
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
    tableName: "roles",
    underscored: true,
    timestamps: true,
  },
);

export { Role };
