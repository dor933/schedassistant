"use strict";

/**
 * Seed a system admin user (password: "Sys@dm1n!2026#Gr4hamy").
 *
 * Creates a `persons` row first and reuses its id for the linked `users` row.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, _Sequelize) {
    // Password "Sys@dm1n!2026#Gr4hamy" hashed with bcrypt (10 rounds).
    // CHANGE THIS IN PRODUCTION via a direct DB update.
    const bcryptHash =
      "$2b$10$ntns1t390KhW5VJCrBKlV.5csFRPG3/RmYVKW8BSJJ1EhoWZ8YMm.";

    // Insert into persons → users in a single statement using a CTE so the
    // user's id matches the person's id.
    await queryInterface.sequelize.query(
      `WITH new_person AS (
         INSERT INTO persons (first_name, last_name, created_at, updated_at)
         SELECT 'System', 'Admin', NOW(), NOW()
         WHERE NOT EXISTS (SELECT 1 FROM users WHERE display_name = 'System Admin')
         RETURNING id
       )
       INSERT INTO users (id, display_name, user_identity, password, created_at, updated_at)
       SELECT id, 'System Admin', '{"role":"admin"}'::jsonb, :password, NOW(), NOW()
       FROM new_person`,
      { replacements: { password: bcryptHash } },
    );
  },

  async down(_queryInterface, _Sequelize) {
    // Do not delete seed data on down — it may have been used by other rows.
  },
};
