"use strict";

/**
 * Adds 'application' as a fourth value to the agents.type enum.
 *
 * Application agents are REST-triggered agents built on the deepagents
 * library. Unlike primary/system/external agents (which run inside chat /
 * roundtable / delegation flows), application agents are invoked
 * synchronously by external callers via POST /api/application/:agentId/invoke.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_agents_type" ADD VALUE IF NOT EXISTS 'application'`,
    );
  },

  async down(_queryInterface, _Sequelize) {
    // PostgreSQL does not support removing enum values.
    // The value will remain but is harmless if unused.
  },
};
