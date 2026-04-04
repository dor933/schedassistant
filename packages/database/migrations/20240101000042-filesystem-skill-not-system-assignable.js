"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE skills SET system_agent_assignable = false, updated_at = NOW() WHERE slug = 'mcp-filesystem-repo'`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE skills SET system_agent_assignable = true, updated_at = NOW() WHERE slug = 'mcp-filesystem-repo'`,
    );
  },
};
