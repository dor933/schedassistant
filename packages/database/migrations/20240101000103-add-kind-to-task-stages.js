"use strict";

/**
 * Adds `kind` to `task_stages`.
 *
 * Distinguishes "plan" stages — research/design work that produces no code
 * changes and never needs a PR — from "code_change" stages, which is the
 * existing flow (feature branch → commits → PR → user approval → next stage).
 *
 * Behavioural difference (handled in epicTaskUtils.ts / epicTask.service.ts):
 *   - kind='code_change' (default): unchanged. propagateStatus moves a fully
 *     completed stage to 'pr_pending', autoCreateStagePr opens the PR, and
 *     getReadyTasks blocks the next stage on `pr_status IN
 *     ('approved','merged')`.
 *   - kind='plan': propagateStatus skips 'pr_pending' and writes 'completed'
 *     directly, no PR is created, and getReadyTasks accepts a previous stage
 *     as cleared as soon as it's status='completed' regardless of pr_status.
 *
 * Default 'code_change' so every existing row keeps its current behaviour
 * (no data backfill needed).
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("task_stages", "kind", {
      type: Sequelize.STRING(32),
      allowNull: false,
      defaultValue: "code_change",
    });
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeColumn("task_stages", "kind");
  },
};
