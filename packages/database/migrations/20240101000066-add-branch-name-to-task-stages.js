"use strict";

/**
 * Adds `branch_name` to `task_stages`.
 *
 * When a stage's PR is created, the working branch Claude CLI produced
 * (e.g. `epic/foo-stage-1`) is persisted on the stage so that later retries
 * (e.g. after `request_stage_changes`) can fetch/checkout/pull that exact
 * branch instead of the repository's default branch.
 *
 * NULL means "no stage branch yet" — retries/executions fall back to the
 * repository's default branch, which is the correct behavior for a fresh
 * epic whose first stage hasn't produced a PR yet.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("task_stages", "branch_name", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeColumn("task_stages", "branch_name");
  },
};
