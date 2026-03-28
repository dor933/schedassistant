"use strict";

/**
 * Seed two admin users: maora and danz.
 * Same password as SYSTEM user ("Sys@dm1n!2026#Gr4hamy").
 * Admin role ID: 00000000-0000-4000-c000-000000000001
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, _Sequelize) {
    const bcryptHash =
      "$2b$10$ntns1t390KhW5VJCrBKlV.5csFRPG3/RmYVKW8BSJJ1EhoWZ8YMm.";
    const adminRoleId = "00000000-0000-4000-c000-000000000001";

    await queryInterface.sequelize.query(
      `INSERT INTO users (user_name, display_name, user_identity, password, role_id, created_at, updated_at)
       VALUES
         ('maora', 'Maor A', '{"role":"admin"}'::jsonb, :password, :roleId, NOW(), NOW()),
         ('danz',  'Dan Z',  '{"role":"admin"}'::jsonb, :password, :roleId, NOW(), NOW())
       ON CONFLICT (user_name) DO NOTHING`,
      { replacements: { password: bcryptHash, roleId: adminRoleId } },
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `DELETE FROM users WHERE user_name IN ('maora', 'danz')`,
    );
  },
};
