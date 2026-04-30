import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type {
  CliExecutionAttributes,
  CliExecutionStatus,
  CliProvider,
  CliInvokedVia,
  AgentId,
  AgentTaskId,
  UserId,
} from "@scheduling-agent/types";

/**
 * Provider-agnostic ledger for CLI subprocess invocations. Backs the
 * `cli_executions` table created in migration 20240101000112.
 *
 * Inserted (status='running') before spawn; finalized on close. The pre-spawn
 * busy check uses `pgrep` against the live OS, not this table — so a phantom
 * `running` row left by a crashed container is harmless beyond accounting,
 * and is cleaned up by the startup sweep.
 */
type CliExecutionCreationAttributes = Optional<
  CliExecutionAttributes,
  | "id"
  | "agentId"
  | "userId"
  | "threadId"
  | "agentTaskId"
  | "systemPrompt"
  | "cliAgentName"
  | "model"
  | "sessionId"
  | "parentSessionId"
  | "status"
  | "result"
  | "stderr"
  | "exitCode"
  | "pid"
  | "costUsd"
  | "durationMs"
  | "numTurns"
  | "isError"
  | "providerMetadata"
  | "startedAt"
  | "completedAt"
  | "createdAt"
  | "updatedAt"
>;

class CliExecution
  extends Model<CliExecutionAttributes, CliExecutionCreationAttributes>
  implements CliExecutionAttributes
{
  declare id: string;
  declare provider: CliProvider;
  declare agentId: AgentId | null;
  declare userId: UserId | null;
  declare threadId: string | null;
  declare agentTaskId: AgentTaskId | null;
  declare cwd: string;
  declare prompt: string;
  declare systemPrompt: string | null;
  declare cliAgentName: string | null;
  declare model: string | null;
  declare sessionId: string | null;
  declare parentSessionId: string | null;
  declare status: CliExecutionStatus;
  declare result: string | null;
  declare stderr: string | null;
  declare exitCode: number | null;
  declare pid: number | null;
  declare costUsd: number | null;
  declare durationMs: number | null;
  declare numTurns: number | null;
  declare isError: boolean | null;
  declare invokedVia: CliInvokedVia;
  declare providerMetadata: Record<string, unknown>;
  declare startedAt: Date;
  declare completedAt: Date | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

CliExecution.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    provider: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    agentId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "agent_id",
      references: { model: "agents", key: "id" },
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "user_id",
      references: { model: "users", key: "id" },
    },
    threadId: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: "thread_id",
    },
    agentTaskId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "agent_task_id",
      references: { model: "agent_tasks", key: "id" },
    },
    cwd: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    prompt: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    systemPrompt: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "system_prompt",
    },
    cliAgentName: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: "cli_agent_name",
    },
    model: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    sessionId: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: "session_id",
    },
    parentSessionId: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: "parent_session_id",
    },
    status: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: "running",
    },
    result: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    stderr: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    exitCode: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "exit_code",
    },
    pid: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // Sequelize returns DECIMAL as string by default to preserve precision —
    // `get()` re-parses to Number so callers see a plain number. Caller-side
    // arithmetic on cost values stays straightforward.
    costUsd: {
      type: DataTypes.DECIMAL(10, 6),
      allowNull: true,
      field: "cost_usd",
      get(): number | null {
        const raw = this.getDataValue("costUsd");
        if (raw === null || raw === undefined) return null;
        return typeof raw === "number" ? raw : Number(raw);
      },
    },
    durationMs: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "duration_ms",
    },
    numTurns: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "num_turns",
    },
    isError: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      field: "is_error",
    },
    invokedVia: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: "invoked_via",
    },
    providerMetadata: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
      field: "provider_metadata",
    },
    startedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: "started_at",
    },
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "completed_at",
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: "created_at",
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: "updated_at",
    },
  },
  {
    sequelize,
    tableName: "cli_executions",
    underscored: true,
    timestamps: true,
  },
);

import { Agent } from "./Agent";
import { AgentTask } from "./AgentTask";
import { User } from "./User";

CliExecution.belongsTo(Agent, { foreignKey: "agentId", as: "agent" });
CliExecution.belongsTo(User, { foreignKey: "userId", as: "user" });
CliExecution.belongsTo(AgentTask, {
  foreignKey: "agentTaskId",
  as: "agentTask",
});

export { CliExecution };
