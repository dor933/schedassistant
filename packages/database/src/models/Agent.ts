import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { AgentAttributes, AgentType, UserId } from "@scheduling-agent/types";

type AgentCreationAttributes = Optional<
  AgentAttributes,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "definition"
  | "coreInstructions"
  | "characteristics"
  | "activeThreadId"
  | "agentName"
  | "createdByUserId"
  | "modelId"
  | "agentNotes"
  | "workspacePath"
  | "slug"
  | "description"
  | "instructions"
  | "modelSlug"
  | "toolConfig"
  | "userId"
  | "isLocked"
  | "organizationId"
  | "owningPrimaryAgentId"
>;

class Agent extends Model<AgentAttributes, AgentCreationAttributes> implements AgentAttributes {
  declare id: string;
  declare type: AgentType;
  declare definition: string | null;
  declare slug: string | null;
  declare agentName: string | null;
  declare description: string | null;
  declare coreInstructions: string | null;
  declare instructions: string | null;
  declare characteristics: Record<string, unknown> | null;
  declare activeThreadId: string | null;
  declare createdByUserId: UserId | null;
  declare userId: UserId | null;
  declare modelId: string | null;
  declare modelSlug: string | null;
  declare toolConfig: Record<string, unknown> | null;
  declare agentNotes: string | null;
  declare workspacePath: string | null;
  declare isLocked: boolean;
  declare organizationId: string;
  declare owningPrimaryAgentId: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

Agent.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    type: {
      type: DataTypes.ENUM("primary", "system", "external"),
      allowNull: false,
      defaultValue: "primary",
    },
    definition: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    slug: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    agentName: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "agent_name",
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    coreInstructions: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "core_instructions",
    },
    instructions: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    characteristics: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    activeThreadId: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "active_thread_id",
      references: { model: "threads", key: "id" },
    },
    createdByUserId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "created_by_user_id",
      references: { model: "users", key: "id" },
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "user_id",
      references: { model: "users", key: "id" },
    },
    modelId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "model_id",
      references: { model: "models", key: "id" },
    },
    modelSlug: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "model_slug",
    },
    toolConfig: {
      type: DataTypes.JSONB,
      allowNull: true,
      field: "tool_config",
    },
    agentNotes: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "agent_notes",
    },
    workspacePath: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "workspace_path",
    },
    isLocked: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: "is_locked",
    },
    organizationId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "organization_id",
      references: { model: "organizations", key: "id" },
    },
    owningPrimaryAgentId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "owning_primary_agent_id",
      references: { model: "agents", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
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
    tableName: "agents",
    underscored: true,
    timestamps: true,
  },
);

export { Agent };
