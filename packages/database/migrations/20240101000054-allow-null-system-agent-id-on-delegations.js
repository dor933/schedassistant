"use strict";

/**
 * Makes `system_agent_id` nullable on `deep_agent_delegations` so epic
 * orchestrator delegations (which don't target a system agent) can be stored.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn("deep_agent_delegations", "system_agent_id", {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: "system_agents", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "CASCADE",
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn("deep_agent_delegations", "system_agent_id", {
      type: Sequelize.INTEGER,
      allowNull: false,
      references: { model: "system_agents", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "CASCADE",
    });
  },
};
