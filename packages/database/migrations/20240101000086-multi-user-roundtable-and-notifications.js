"use strict";

/**
 * Multi-user roundtables + general in-app notifications.
 *
 * - Creates `roundtable_users` junction table (roundtable_id, user_id, turn_order,
 *   turns_completed). One row per participating human, ordered like roundtable_agents.
 * - Creates `notifications` table for in-app alerts (roundtable invites, turn prompts,
 *   completion). Includes JSONB data payload and optional deep link.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("roundtable_users", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      roundtable_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "roundtables", key: "id" },
        onDelete: "CASCADE",
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },
      turn_order: { type: Sequelize.INTEGER, allowNull: false },
      turns_completed: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
    });
    await queryInterface.addIndex("roundtable_users", ["roundtable_id", "user_id"], {
      unique: true,
      name: "roundtable_users_roundtable_user_unique",
    });

    // notifications
    await queryInterface.createTable("notifications", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },
      type: { type: Sequelize.STRING, allowNull: false },
      title: { type: Sequelize.STRING(200), allowNull: false },
      body: { type: Sequelize.TEXT, allowNull: true },
      link: { type: Sequelize.STRING(500), allowNull: true },
      data: { type: Sequelize.JSONB, allowNull: true },
      read_at: { type: Sequelize.DATE, allowNull: true },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
    });
    await queryInterface.addIndex("notifications", ["user_id", "read_at"], {
      name: "notifications_user_read_idx",
    });
    await queryInterface.addIndex("notifications", ["user_id", "created_at"], {
      name: "notifications_user_created_idx",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("notifications", "notifications_user_created_idx");
    await queryInterface.removeIndex("notifications", "notifications_user_read_idx");
    await queryInterface.dropTable("notifications");
    await queryInterface.removeIndex(
      "roundtable_users",
      "roundtable_users_roundtable_user_unique",
    );
    await queryInterface.dropTable("roundtable_users");
  },
};
