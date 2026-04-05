"use strict";

/**
 * Create the `conversation_messages` table — the canonical, conversation-scoped
 * store for every user / assistant message visible in the UI.
 *
 * Keyed by `single_chat_id` (which is also the LangGraph checkpoint thread_id).
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(`
      CREATE TABLE conversation_messages (
        id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
        single_chat_id UUID          NOT NULL REFERENCES single_chats(id) ON DELETE CASCADE,
        role           VARCHAR(16)   NOT NULL CHECK (role IN ('user', 'assistant')),
        content        TEXT          NOT NULL,
        sender_name    VARCHAR(255),
        request_id     VARCHAR(255),
        model_slug     VARCHAR(128),
        vendor_slug    VARCHAR(128),
        model_name     VARCHAR(128),
        created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );

      CREATE INDEX idx_conv_msgs_single_chat ON conversation_messages (single_chat_id, created_at);
    `);
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS conversation_messages`);
  },
};
