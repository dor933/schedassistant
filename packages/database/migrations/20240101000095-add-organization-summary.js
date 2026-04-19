"use strict";

/**
 * Adds a free-text `summary` column to `organizations`. The summary is an
 * admin-authored blurb about the company/team that gets prepended to every
 * agent system prompt in that org, so every agent shares common grounding
 * about who it's working for.
 *
 * Nullable; orgs that have no summary yet simply produce no section in the
 * system prompt.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("organizations", "summary", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("organizations", "summary");
  },
};
