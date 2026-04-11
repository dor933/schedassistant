"use strict";

/**
 * Adds `base_commit_sha` to `task_stages`.
 *
 * This is the commit SHA the stage branch was rooted at when
 * `preExecutionSync` first created it — i.e. the tip of the repo's default
 * branch at stage start. It is the **user-facing baseline** for the stage:
 * the diff the user reviews ("did the agent do what I asked?") is computed
 * as `git diff <base_commit_sha>..HEAD` on the stage branch, which captures
 * every commit the stage produced across all its tasks as one coherent
 * change set — matching the user's mental model that a stage is one logical
 * unit of work regardless of how many tasks it was decomposed into.
 *
 * Distinct from per-task diffs, which are computed against a snapshot
 * captured at the start of each individual `executeTask` call and are
 * scoped to a single execution for audit / `review_task_diff` use.
 *
 * NULL means the stage has not been started yet (no branch created), in
 * which case there is no stage diff to show.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("task_stages", "base_commit_sha", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeColumn("task_stages", "base_commit_sha");
  },
};
