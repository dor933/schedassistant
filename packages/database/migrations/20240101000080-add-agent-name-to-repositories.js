"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("repositories", "agent_name", {
      type: Sequelize.STRING(255),
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("repositories", "agent_name");
  },
};
