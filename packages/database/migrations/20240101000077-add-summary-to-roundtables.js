"use strict";

/**
 * Adds `summary` and `summary_generated_at` columns to `roundtables`.
 * The summary is generated once the roundtable completes (one-off LLM call)
 * and is mirrored into each participant's episodic memory.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("roundtables", "summary", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn("roundtables", "summary_generated_at", {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeColumn("roundtables", "summary_generated_at");
    await queryInterface.removeColumn("roundtables", "summary");
  },
};
