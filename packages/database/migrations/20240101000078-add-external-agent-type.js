"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_agents_type" ADD VALUE IF NOT EXISTS 'external'`,
    );
  },

  async down(_queryInterface, _Sequelize) {
    // PostgreSQL does not support removing enum values.
    // The value will remain but is harmless if unused.
  },
};
