"use strict";

/**
 * Changes `conversation_messages.request_id` from UUID to VARCHAR(255).
 *
 * The column was originally typed UUID, but delegation-result and
 * consultation-chain jobs write prefixed strings like
 * "delegation-<uuid>" and "consultation-chain-<uuid>", which are
 * rejected by PostgreSQL's UUID parser. This caused silent insert
 * failures (messages visible via socket but missing after page refresh).
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE conversation_messages
        ALTER COLUMN request_id TYPE VARCHAR(255)
        USING request_id::VARCHAR(255);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE conversation_messages
        ALTER COLUMN request_id TYPE UUID
        USING request_id::UUID;
    `);
  },
};
