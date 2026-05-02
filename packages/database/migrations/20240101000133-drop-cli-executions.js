"use strict";

/**
 * Drops the `cli_executions` table and the now-orphan FK columns on
 * `task_executions` (slice 22 follow-up).
 *
 * Why this is safe now:
 *   - The `runCliExecution` engine + its callers were deleted in
 *     slice 21/22 (architecture overview moved to the SDK scan
 *     helpers; legacy `executeTask` + `ExecuteEpicTaskTool` removed;
 *     `run_*_cli` / `kill_cli_execution` tools retired).
 *   - No code path writes to `cli_executions` after that cleanup, so
 *     historical rows are read by no one. Keeping them as audit data
 *     was the only argument for retention; moot once we add this drop.
 *   - `task_executions.cli_session_id` and `cli_execution_id` are dead
 *     columns: the new `StartEpicTaskTool` / `CompleteEpicTaskTool`
 *     lifecycle (slice 20) doesn't populate either. Sub-agent dispatch
 *     manages session continuity through `threads.claude_session_id` /
 *     `threads.codex_thread_id` — different table, different mechanism.
 *
 * Order of operations:
 *   1. Drop the FK + index from `task_executions.cli_execution_id` (the
 *      FK references `cli_executions.id`, so the column must lose its
 *      reference before the table can be dropped).
 *   2. Drop the two dead columns on `task_executions`.
 *   3. Drop the indexes on `cli_executions`.
 *   4. Drop the `cli_executions` table itself.
 *
 * Down: this is a one-way drop. Restoring the table would resurrect a
 * schema for a runtime that no longer exists; the column data is gone
 * regardless. The down hook explicitly throws so an accidental rollback
 * doesn't silently corrupt the schema with empty resurrected columns.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, _Sequelize) {
    // 1. Detach task_executions from cli_executions so the FK doesn't
    //    block the table drop.
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS task_executions_cli_execution_id`,
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE task_executions
         DROP COLUMN IF EXISTS cli_execution_id`,
    );

    // 2. Drop the other dead column. cli_session_id was the Claude CLI's
    //    --resume token; replaced by threads.claude_session_id at the
    //    SDK layer.
    await queryInterface.sequelize.query(
      `ALTER TABLE task_executions
         DROP COLUMN IF EXISTS cli_session_id`,
    );

    // 3. Drop indexes on cli_executions. We use IF EXISTS so a partial
    //    state from a failed prior run doesn't block the migration.
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS cli_executions_running_idx`,
    );
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS cli_executions_resume_lookup`,
    );
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS cli_executions_agent_task_id`,
    );
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS cli_executions_session_id`,
    );

    // 4. Drop the table. CASCADE handles any FK we missed (e.g. an
    //    integration we forgot about referencing `cli_executions.id`).
    //    With this slice's scope — agent_id, user_id, agent_task_id all
    //    point AT other tables, not the other way — the CASCADE is
    //    defensive, not load-bearing.
    await queryInterface.sequelize.query(
      `DROP TABLE IF EXISTS cli_executions CASCADE`,
    );
  },

  async down(_queryInterface, _Sequelize) {
    throw new Error(
      "Migration 20240101000133-drop-cli-executions is one-way. " +
        "The CLI subprocess engine and its callers were deleted in " +
        "slice 21/22; rolling back this migration would resurrect a " +
        "schema for runtime code that no longer exists. If you need " +
        "to revert, restore `apps/agent_service/src/utils/cliExecution.ts`, " +
        "`cliProviders/`, the `run_*_cli` / `kill_cli_execution` tools, " +
        "and the legacy epic-CLI execute path before re-running the " +
        "create-cli-executions migration manually.",
    );
  },
};
