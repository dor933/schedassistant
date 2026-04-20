"use strict";

/**
 * User-in-the-loop roundtable support.
 *
 * - Adds `include_user` boolean on `roundtables` (default false).
 * - Makes `roundtable_messages.agent_id` nullable.
 * - Adds `roundtable_messages.user_id` FK to users.id.
 * - Adds CHECK constraint: exactly one of (agent_id, user_id) is non-null.
 * - Widens the roundtables.status CHECK to allow "waiting_for_user".
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    // Every DDL below uses IF [NOT] EXISTS so this migration can rerun cleanly
    // on a database where an earlier attempt applied some of the steps.

    await queryInterface.sequelize.query(
      `ALTER TABLE roundtables
       ADD COLUMN IF NOT EXISTS include_user BOOLEAN NOT NULL DEFAULT false`,
    );

    // Widen roundtables.status enum to include waiting_for_user
    await queryInterface.sequelize.query(
      `ALTER TABLE roundtables DROP CONSTRAINT IF EXISTS roundtables_status_check`,
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE roundtables ADD CONSTRAINT roundtables_status_check
       CHECK (status IN ('pending', 'running', 'waiting_for_user', 'completed', 'failed'))`,
    );

    // agent_id becomes nullable (no-op if already nullable)
    await queryInterface.sequelize.query(
      `ALTER TABLE roundtable_messages ALTER COLUMN agent_id DROP NOT NULL`,
    );

    // user_id (nullable FK to users.id)
    await queryInterface.sequelize.query(
      `ALTER TABLE roundtable_messages
       ADD COLUMN IF NOT EXISTS user_id INTEGER
       REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL`,
    );

    // Exactly one of (agent_id, user_id) must be set — drop first so a rerun
    // replaces any stale constraint definition.
    await queryInterface.sequelize.query(
      `ALTER TABLE roundtable_messages
       DROP CONSTRAINT IF EXISTS roundtable_messages_author_xor_check`,
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE roundtable_messages
       ADD CONSTRAINT roundtable_messages_author_xor_check
       CHECK ((agent_id IS NOT NULL) <> (user_id IS NOT NULL))`,
    );

    await queryInterface.sequelize.query(
      `CREATE INDEX IF NOT EXISTS roundtable_messages_user_id
       ON roundtable_messages (user_id)`,
    );
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex(
      "roundtable_messages",
      "roundtable_messages_user_id",
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE roundtable_messages
       DROP CONSTRAINT IF EXISTS roundtable_messages_author_xor_check`,
    );
    await queryInterface.removeColumn("roundtable_messages", "user_id");
    await queryInterface.changeColumn("roundtable_messages", "agent_id", {
      type: Sequelize.UUID,
      allowNull: false,
      references: { model: "agents", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "CASCADE",
    });

    await queryInterface.sequelize.query(
      `ALTER TABLE roundtables DROP CONSTRAINT IF EXISTS roundtables_status_check`,
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE roundtables ADD CONSTRAINT roundtables_status_check
       CHECK (status IN ('pending', 'running', 'completed', 'failed'))`,
    );

    await queryInterface.removeColumn("roundtables", "include_user");
  },
};
