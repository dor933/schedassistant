"use strict";

/** @type {import('sequelize-cli').Migration}
 *
 * System agents must never have their own workspace folder — when they run
 * as executors for a delegation, they write into the *caller's* workspace
 * (the orchestrator that invoked them). Clear any `workspace_path` that may
 * have been set on system agents by older seeds or admin edits.
 *
 * Primary agents (including the Epic Task Orchestrator, which is `type =
 * 'primary'`) are NOT touched — they keep their workspace_path.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE agents
         SET workspace_path = NULL,
             updated_at = NOW()
       WHERE type = 'system'
         AND workspace_path IS NOT NULL`,
    );
  },

  async down() {
    // Irreversible: we don't track which system agents previously had a
    // workspace_path set, and restoring arbitrary values would be wrong.
    // Leaving as no-op.
  },
};
