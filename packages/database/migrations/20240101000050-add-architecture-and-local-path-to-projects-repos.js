"use strict";

/**
 * Adds context columns so the orchestrator can understand repo/project
 * architecture and locate local clones:
 *
 * projects:
 *   - architecture_overview  (TEXT) — high-level project architecture description
 *   - tech_stack             (TEXT) — languages, frameworks, major dependencies
 *
 * repositories:
 *   - architecture_overview  (TEXT) — repo-specific structure (folder tree, component layout, etc.)
 *   - local_path             (TEXT) — absolute path to the local clone on the machine
 *   - setup_instructions     (TEXT) — how to install deps, run dev server, build, etc.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // ── Projects ──
    await queryInterface.addColumn("projects", "architecture_overview", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn("projects", "tech_stack", {
      type: Sequelize.TEXT,
      allowNull: true,
    });

    // ── Repositories ──
    await queryInterface.addColumn("repositories", "architecture_overview", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn("repositories", "local_path", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn("repositories", "setup_instructions", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("repositories", "setup_instructions");
    await queryInterface.removeColumn("repositories", "local_path");
    await queryInterface.removeColumn("repositories", "architecture_overview");
    await queryInterface.removeColumn("projects", "tech_stack");
    await queryInterface.removeColumn("projects", "architecture_overview");
  },
};
