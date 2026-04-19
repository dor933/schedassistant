"use strict";

/**
 * Platform admins — a separate principal type that exists *outside* the tenant
 * model. They have no `organization_id`, no role row, no `users` row. They
 * authenticate through a dedicated login endpoint, carry a disjoint JWT, and
 * are the only principals allowed to mutate platform-wide catalogs (MCP
 * servers, skills, models, vendor API keys). This keeps cross-tenant admin
 * powers physically separated from tenant super_admins, which are strictly
 * scoped to their own organization.
 *
 * Seeding is deliberately out-of-band: see
 * `apps/user_app/scripts/create-platform-admin.ts`. We never ship a hashed
 * credential in a migration.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("platform_admins", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
        allowNull: false,
      },
      email: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      password_hash: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      last_login_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("NOW()"),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("NOW()"),
      },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("platform_admins");
  },
};
