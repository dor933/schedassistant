"use strict";

/**
 * Seed a test user (password: "Sys@dm1n!2026#Gr4hamy")
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {

    const bcryptHash =
      "$2b$10$ntns1t390KhW5VJCrBKlV.5csFRPG3/RmYVKW8BSJJ1EhoWZ8YMm.";

    await queryInterface.sequelize.query(
      `INSERT INTO users (id, user_name, display_name, user_identity, password, created_at, updated_at)
       VALUES ('TEST', 'testuser', 'Test User', '{"role":"user"}'::jsonb, :password, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      { replacements: { password: bcryptHash } },
    );


  },

  async down(queryInterface, _Sequelize) {
    // Do not delete seed data on down — it may have been used by other rows.
  },
};
