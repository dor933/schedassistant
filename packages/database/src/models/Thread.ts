import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { ThreadAttributes, SessionSummary } from "@scheduling-agent/types";

type ThreadCreationAttributes = Optional<
  ThreadAttributes,
  | "createdAt"
  | "updatedAt"
  | "userId"
  | "agentId"
  | "title"
  | "archivedAt"
  | "lastActivityAt"
  | "ttlExpiresAt"
  | "summarizedAt"
  | "summary"
  | "checkpointSizeBytes"
>;

class Thread extends Model<ThreadAttributes, ThreadCreationAttributes> implements ThreadAttributes {
  declare id: string;
  declare userId: string | null;
  declare agentId: string | null;
  declare title: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare archivedAt: Date | null;
  declare lastActivityAt: Date | null;
  declare ttlExpiresAt: Date | null;
  declare summarizedAt: Date | null;
  declare summary: SessionSummary | null;
  declare checkpointSizeBytes: number | null;
}

Thread.init(
  {
    id: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
    },
    userId: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "user_id",
      references: { model: "users", key: "id" },
    },
    agentId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "agent_id",
      references: { model: "agents", key: "id" },
    },
    title: {
      type: DataTypes.STRING,
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
    archivedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "archived_at",
    },
    lastActivityAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "last_activity_at",
    },
    ttlExpiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "ttl_expires_at",
    },
    summarizedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "summarized_at",
    },
    summary: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    checkpointSizeBytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      field: "checkpoint_size_bytes",
    },
  },
  {
    sequelize,
    tableName: "threads",
    underscored: true,
    timestamps: true,
    indexes: [
      { fields: ["user_id"] },
      { fields: ["agent_id"] },
      { fields: [{ name: "user_id", order: "ASC" }, { name: "summarized_at", order: "DESC" }] },
      { fields: [{ name: "user_id", order: "ASC" }, { name: "updated_at", order: "DESC" }] },
    ],
  },
);

export { Thread };
