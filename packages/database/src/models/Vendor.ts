import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { VendorAttributes } from "@scheduling-agent/types";

type VendorCreationAttributes = Optional<
  VendorAttributes,
  "id" | "createdAt" | "updatedAt"
>;

class Vendor
  extends Model<VendorAttributes, VendorCreationAttributes>
  implements VendorAttributes
{
  declare id: string;
  declare name: string;
  declare slug: string;
  declare createdAt: Date;
  declare updatedAt: Date;
}

Vendor.init(
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
    slug: {
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
    tableName: "vendors",
    underscored: true,
    timestamps: true,
  },
);

export { Vendor };
