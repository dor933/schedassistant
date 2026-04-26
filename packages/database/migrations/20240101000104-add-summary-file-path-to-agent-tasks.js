"use strict";

/**
 * Adds `summary_file_path` to `agent_tasks`.
 *
 * Stores the absolute path of the per-task summary `.md` the CLI executor is
 * instructed to write into the current thread's session folder on every run.
 * Updated on every `executeTask` (including retries) — so the column always
 * points at the *latest* attempt's summary, even when prior attempts wrote
 * files into different threads' folders that the user later rejected.
 *
 * Used by:
 *   - `get_epic_task_stages_and_tasks` tool — surfaces these paths in the
 *     orchestrator can fan them out via `send_file_to_user`.
 *   - Future "show me what we did" flows that pivot from
 *     `search_epic_tasks_by_date` to the actual deliverables.
 *
 * NULL means "no summary captured yet" — task hasn't run successfully, or
 * ran on a build before this column existed. Both retrieval tools must
 * tolerate NULLs (skip / surface as "no summary available").
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("agent_tasks", "summary_file_path", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeColumn("agent_tasks", "summary_file_path");
  },
};
