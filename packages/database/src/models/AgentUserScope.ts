import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type {
  AgentId,
  AgentUserScopeAttributes,
  GoogleScope,
  OrganizationId,
  UserId,
} from "@scheduling-agent/types";

type CreationAttrs = Optional<
  AgentUserScopeAttributes,
  "id" | "grantedByUserId" | "grantedAt" | "createdAt" | "updatedAt"
>;

class AgentUserScope
  extends Model<AgentUserScopeAttributes, CreationAttrs>
  implements AgentUserScopeAttributes
{
  declare id: string;
  declare agentId: AgentId;
  declare subjectUserId: UserId;
  declare organizationId: OrganizationId;
  declare scope: GoogleScope;
  declare grantedByUserId: UserId | null;
  declare grantedAt: Date;
  declare createdAt: Date;
  declare updatedAt: Date;
}

AgentUserScope.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    agentId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "agent_id",
      references: { model: "agents", key: "id" },
    },
    subjectUserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "subject_user_id",
      references: { model: "users", key: "id" },
    },
    organizationId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "organization_id",
      references: { model: "organizations", key: "id" },
    },
    scope: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    grantedByUserId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "granted_by_user_id",
      references: { model: "users", key: "id" },
    },
    grantedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "granted_at",
      defaultValue: DataTypes.NOW,
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
    tableName: "agent_user_scopes",
    underscored: true,
    timestamps: true,
  },
);

export { AgentUserScope };
