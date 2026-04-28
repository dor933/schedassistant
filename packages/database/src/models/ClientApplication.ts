import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { ClientApplicationAttributes } from "@scheduling-agent/types";

type ClientApplicationCreationAttributes = Optional<
  ClientApplicationAttributes,
  "id" | "createdAt" | "updatedAt" | "apiTokenHash"
>;

class ClientApplication
  extends Model<ClientApplicationAttributes, ClientApplicationCreationAttributes>
  implements ClientApplicationAttributes
{
  declare id: string;
  declare organizationId: string;
  declare name: string;
  declare slug: string;
  declare apiTokenHash: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

ClientApplication.init(
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
      references: { model: "organizations", key: "id" },
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
    apiTokenHash: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "api_token_hash",
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
    tableName: "client_applications",
    underscored: true,
    timestamps: true,
  },
);

export { ClientApplication };
