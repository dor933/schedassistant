"use strict";

/**
 * 1. Create `roles` table with "admin" and "user" seed records.
 * 2. Add `role_id` FK to `users` table.
 * 3. Assign "admin" role to the SYSTEM user, "user" role to everyone else.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Create roles table
    await queryInterface.createTable("roles", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
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

    // 2. Seed admin and user roles with fixed UUIDs
    await queryInterface.sequelize.query(
      `INSERT INTO roles (id, name, created_at, updated_at) VALUES
        ('00000000-0000-4000-c000-000000000001', 'admin', NOW(), NOW()),
        ('00000000-0000-4000-c000-000000000002', 'user', NOW(), NOW())
      ON CONFLICT (name) DO NOTHING`,
    );

    // 3. Add role_id column to users
    await queryInterface.addColumn("users", "role_id", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "roles", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    });

    // 4. Assign admin role to SYSTEM user, user role to everyone else
    await queryInterface.sequelize.query(
      `UPDATE users SET role_id = '00000000-0000-4000-c000-000000000001' WHERE id = 1`,
    );
    await queryInterface.sequelize.query(
      `UPDATE users SET role_id = '00000000-0000-4000-c000-000000000002' WHERE id != 1 AND role_id IS NULL`,
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("users", "role_id");
    await queryInterface.dropTable("roles");
  },
};
