"use strict";

/**
 * Add "super_admin" role and reassign SYSTEM user to it.
 *
 * Role IDs:
 *   admin       = 00000000-0000-4000-c000-000000000001
 *   user        = 00000000-0000-4000-c000-000000000002
 *   super_admin = 00000000-0000-4000-c000-000000000003
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, _Sequelize) {
    const superAdminRoleId = "00000000-0000-4000-c000-000000000003";

    // 1. Create the super_admin role
    await queryInterface.sequelize.query(
      `INSERT INTO roles (id, name, created_at, updated_at)
       VALUES (:id, 'super_admin', NOW(), NOW())
       ON CONFLICT (name) DO NOTHING`,
      { replacements: { id: superAdminRoleId } },
    );

    // 2. Reassign SYSTEM user from admin → super_admin
    await queryInterface.sequelize.query(
      `UPDATE users SET role_id = :roleId, updated_at = NOW() WHERE id = 1`,
      { replacements: { roleId: superAdminRoleId } },
    );
  },

  async down(queryInterface, _Sequelize) {
    const adminRoleId = "00000000-0000-4000-c000-000000000001";
    const superAdminRoleId = "00000000-0000-4000-c000-000000000003";

    // Revert SYSTEM back to admin
    await queryInterface.sequelize.query(
      `UPDATE users SET role_id = :roleId, updated_at = NOW() WHERE id = 1`,
      { replacements: { roleId: adminRoleId } },
    );

    // Remove super_admin role
    await queryInterface.sequelize.query(
      `DELETE FROM roles WHERE id = :id`,
      { replacements: { id: superAdminRoleId } },
    );
  },
};
