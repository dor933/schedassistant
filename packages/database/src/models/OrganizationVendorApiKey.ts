import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";

export interface OrganizationVendorApiKeyAttributes {
  id: string;
  organizationId: string;
  vendorId: string;
  apiKey: string;
  createdAt: Date;
  updatedAt: Date;
}

type CreationAttributes = Optional<
  OrganizationVendorApiKeyAttributes,
  "id" | "createdAt" | "updatedAt"
>;

class OrganizationVendorApiKey
  extends Model<OrganizationVendorApiKeyAttributes, CreationAttributes>
  implements OrganizationVendorApiKeyAttributes
{
  declare id: string;
  declare organizationId: string;
  declare vendorId: string;
  declare apiKey: string;
  declare createdAt: Date;
  declare updatedAt: Date;
}

OrganizationVendorApiKey.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    organizationId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "organization_id",
    },
    vendorId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "vendor_id",
    },
    apiKey: {
      type: DataTypes.TEXT,
      allowNull: false,
      field: "api_key",
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
    tableName: "organization_vendor_api_keys",
    underscored: true,
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["organization_id", "vendor_id"],
        name: "organization_vendor_api_keys_org_vendor_unique",
      },
    ],
  },
);

export { OrganizationVendorApiKey };
