"use strict";

/**
 * Creates `cli_executions` — a provider-agnostic ledger for every CLI
 * subprocess we spawn (Claude CLI today, Codex CLI next, future providers
 * via the same shape). Replaces the ad-hoc spawn-and-forget path scattered
 * through `epicTaskUtils.ts` and gives non-epic agents (granted the
 * `run_*_cli` tools) a place to record sessions, costs, and resume targets.
 *
 * Provider differentiation:
 *   - `provider` is a STRING(32) (not a Postgres ENUM type) to match the
 *     codebase convention — adding a third provider is a no-op migration.
 *   - Provider-specific extras live in `provider_metadata` JSONB so the
 *     common columns stay stable as adapters evolve.
 *
 * Concurrency lock:
 *   - The `idx_cli_exec_running` partial index makes "is anything currently
 *     running?" cheap. The DB row is NOT the source of truth for the lock —
 *     `pgrep -x <binary>` is — but the index supports fast staleness
 *     sweeps on container startup and admin dashboards.
 *
 * Link back to the epic flow:
 *   - `agent_task_id` is nullable: only set when the run was triggered by
 *     `executeTask`. Free-form `run_cli_tool` invocations leave it NULL.
 *   - `task_executions.cli_execution_id` is added so an epic task's
 *     attempt rows point at the underlying CLI process row 1:1.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("cli_executions", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      provider: {
        type: Sequelize.STRING(32),
        allowNull: false,
      },
      // Nullable because admin-triggered runs (e.g. "generate architecture
      // overview" from the repo admin UI) have no agent attribution — the
      // ledger is "what CLI processes ran on this host", not "what work has
      // agent X done." Epic-flow runs always populate this; the
      // `cli_executions_resume_lookup` index handles NULL fine.
      agent_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "agents", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      thread_id: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      agent_task_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "agent_tasks", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      cwd: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      prompt: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      system_prompt: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      cli_agent_name: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      model: {
        type: Sequelize.STRING(128),
        allowNull: true,
      },
      session_id: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      parent_session_id: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      status: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: "running",
      },
      result: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      stderr: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      exit_code: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      pid: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      cost_usd: {
        type: Sequelize.DECIMAL(10, 6),
        allowNull: true,
      },
      duration_ms: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      num_turns: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      is_error: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
      },
      invoked_via: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      provider_metadata: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: {},
      },
      started_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
      completed_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
    });

    // Partial index for the busy/staleness check. Only `running` rows are
    // interesting; full-table scans on a years-old ledger would be wasteful.
    await queryInterface.sequelize.query(
      `CREATE INDEX cli_executions_running_idx
         ON cli_executions (started_at)
         WHERE status = 'running'`,
    );

    // Resume lookup: "most recent session for (provider, agent, thread)".
    // `completed_at DESC NULLS LAST` keeps in-flight rows out of the way
    // while still being usable as a tiebreaker if both timestamps are NULL.
    await queryInterface.addIndex(
      "cli_executions",
      ["provider", "agent_id", "thread_id", "completed_at"],
      { name: "cli_executions_resume_lookup" },
    );

    await queryInterface.addIndex("cli_executions", ["agent_task_id"], {
      name: "cli_executions_agent_task_id",
    });

    await queryInterface.addIndex("cli_executions", ["session_id"], {
      name: "cli_executions_session_id",
    });

    // Link the existing epic-flow attempt rows to the underlying CLI run.
    // Nullable because rows predating this migration have no CLI process
    // row to point at.
    await queryInterface.addColumn("task_executions", "cli_execution_id", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "cli_executions", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    });
    await queryInterface.addIndex("task_executions", ["cli_execution_id"], {
      name: "task_executions_cli_execution_id",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      "task_executions",
      "task_executions_cli_execution_id",
    );
    await queryInterface.removeColumn("task_executions", "cli_execution_id");

    await queryInterface.removeIndex(
      "cli_executions",
      "cli_executions_session_id",
    );
    await queryInterface.removeIndex(
      "cli_executions",
      "cli_executions_agent_task_id",
    );
    await queryInterface.removeIndex(
      "cli_executions",
      "cli_executions_resume_lookup",
    );
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS cli_executions_running_idx`,
    );

    await queryInterface.dropTable("cli_executions");
  },
};
