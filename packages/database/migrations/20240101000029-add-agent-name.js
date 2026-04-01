"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("agents", "agent_name", {
      type: Sequelize.STRING,
      allowNull: true,
      defaultValue: "",
    });
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeColumn("agents", "agent_name");
  },
};
