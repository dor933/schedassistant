import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { OrganizationAttributes } from "@scheduling-agent/types";

type OrganizationCreationAttributes = Optional<
  OrganizationAttributes,
  | "id"
  | "slug"
  | "logo"
  | "summary"
  | "webSearchAgentId"
  | "googleWorkspaceDomain"
  | "googleClientId"
  | "createdAt"
  | "updatedAt"
>;

class Organization
  extends Model<OrganizationAttributes, OrganizationCreationAttributes>
  implements OrganizationAttributes
{
  declare id: string;
  declare name: string;
  declare slug: string | null;
  declare logo: string | null;
  declare summary: string | null;
  declare webSearchAgentId: string | null;
  declare googleWorkspaceDomain: string | null;
  declare googleClientId: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

Organization.init(
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
      allowNull: true,
      unique: true,
    },
    logo: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    summary: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    webSearchAgentId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "web_search_agent_id",
    },
    googleWorkspaceDomain: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
      field: "google_workspace_domain",
    },
    googleClientId: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "google_client_id",
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
    tableName: "organizations",
    underscored: true,
    timestamps: true,
  },
);

export { Organization };
