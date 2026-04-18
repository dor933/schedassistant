import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type {
  AgentCronJobAttributes,
  AgentCronJobStatus,
  AgentId,
  OrganizationId,
  UserId,
} from "@scheduling-agent/types";

type CreationAttrs = Optional<
  AgentCronJobAttributes,
  | "id"
  | "createdByUserId"
  | "timezone"
  | "enabled"
  | "lastRunAt"
  | "lastStatus"
  | "lastError"
  | "createdAt"
  | "updatedAt"
>;

class AgentCronJob
  extends Model<AgentCronJobAttributes, CreationAttrs>
  implements AgentCronJobAttributes
{
  declare id: string;
  declare agentId: AgentId;
  declare organizationId: OrganizationId;
  declare createdByUserId: UserId | null;
  declare name: string;
  declare prompt: string;
  declare cronExpression: string;
  declare timezone: string;
  declare enabled: boolean;
  declare lastRunAt: Date | null;
  declare lastStatus: AgentCronJobStatus | null;
  declare lastError: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

AgentCronJob.init(
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
    organizationId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "organization_id",
      references: { model: "organizations", key: "id" },
    },
    createdByUserId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "created_by_user_id",
      references: { model: "users", key: "id" },
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    prompt: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    cronExpression: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "cron_expression",
    },
    timezone: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "UTC",
    },
    enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    lastRunAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "last_run_at",
    },
    lastStatus: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "last_status",
    },
    lastError: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "last_error",
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
    tableName: "agent_cron_jobs",
    underscored: true,
    timestamps: true,
  },
);

export { AgentCronJob };
