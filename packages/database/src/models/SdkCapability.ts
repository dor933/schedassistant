import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { SdkCapabilityAttributes } from "@scheduling-agent/types";

type SdkCapabilityCreationAttributes = Optional<
  SdkCapabilityAttributes,
  "id" | "createdAt" | "updatedAt" | "description"
>;

class SdkCapability
  extends Model<SdkCapabilityAttributes, SdkCapabilityCreationAttributes>
  implements SdkCapabilityAttributes
{
  declare id: number;
  declare slug: string;
  declare name: string;
  declare description: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

SdkCapability.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    slug: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
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
    tableName: "sdk_capabilities",
    underscored: true,
    timestamps: true,
  },
);

export { SdkCapability };
