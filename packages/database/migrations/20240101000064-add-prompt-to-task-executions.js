"use strict";

/**
 * Adds a `prompt` column to `task_executions` so every Claude CLI run
 * records the exact prompt that was sent. Useful for debugging, audit,
 * and post-hoc review when a task produces unexpected results.
 *
 * @type {import('sequelize-cli').Migration}
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("task_executions", "prompt", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("task_executions", "prompt");
  },
};
