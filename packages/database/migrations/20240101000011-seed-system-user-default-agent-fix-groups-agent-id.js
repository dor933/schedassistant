"use strict";

/**
 * 1. Seed a system admin user (password: "Sys@dm1n!2026#Gr4hamy")
 * 2. Make groups.agent_id NOT NULL (backfill existing rows first)
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Insert system admin user
    //    Password "Sys@dm1n!2026#Gr4hamy" hashed with bcrypt (10 rounds).
    //    Meets policy: 8+ chars, uppercase, lowercase, digit, special char.
    //    CHANGE THIS IN PRODUCTION via a direct DB update.
    const bcryptHash =
      "$2b$10$ntns1t390KhW5VJCrBKlV.5csFRPG3/RmYVKW8BSJJ1EhoWZ8YMm.";

    await queryInterface.sequelize.query(
      `INSERT INTO users (display_name, user_identity, password, created_at, updated_at)
       SELECT 'System Admin', '{"role":"admin"}'::jsonb, :password, NOW(), NOW()
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 1)`,
      { replacements: { password: bcryptHash } },
    );

    // 2. Backfill any existing groups that have NULL agent_id
    await queryInterface.sequelize.query(
      `UPDATE groups SET agent_id = (SELECT id FROM agents LIMIT 1) WHERE agent_id IS NULL`,
    );

    // 3. Make agent_id NOT NULL
    await queryInterface.sequelize.query(
      `ALTER TABLE groups ALTER COLUMN agent_id SET NOT NULL`,
    );
  },

  async down(queryInterface, _Sequelize) {
    // Revert NOT NULL
    await queryInterface.sequelize.query(
      `ALTER TABLE groups ALTER COLUMN agent_id DROP NOT NULL`,
    );

    // Do not delete seed data on down — it may have been used by other rows.
  },
};
