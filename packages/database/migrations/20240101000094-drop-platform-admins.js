"use strict";

/**
 * Drop `platform_admins`. The single-operator platform login now lives in
 * `PLATFORM_ADMIN_EMAIL` + `PLATFORM_ADMIN_PASSWORD` env vars — no more
 * bootstrap script, no more bcrypt row to seed, and no more "empty table =
 * locked out" failure mode. If we ever need multiple platform admins again,
 * roll back this migration and the model/service will need to come back with
 * it (see migration 20240101000023 for the original shape).
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.dropTable("platform_admins");
  },

  async down(queryInterface, Sequelize) {
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
};
