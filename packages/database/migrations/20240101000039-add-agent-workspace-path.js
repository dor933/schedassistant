"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Add the column
    await queryInterface.addColumn("agents", "workspace_path", {
      type: Sequelize.TEXT,
      allowNull: true,
      defaultValue: null,
    });

    // Backfill every existing agent with its workspace path (using definition as folder name)
    await queryInterface.sequelize.query(
      `UPDATE agents SET workspace_path = '/app/data/workspaces/' || definition WHERE workspace_path IS NULL`,
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("agents", "workspace_path");
  },
};
