"use strict";

/**
 * Multi-user roundtables + general in-app notifications.
 *
 * - Creates `roundtable_users` junction table (roundtable_id, user_id, turn_order,
 *   turns_completed). One row per participating human, ordered like roundtable_agents.
 * - Creates `notifications` table for in-app alerts (roundtable invites, turn prompts,
 *   completion). Includes JSONB data payload and optional deep link.
 *
 * Backfill: existing roundtables that had include_user=true get a single
 * roundtable_users row for their creator so the multi-user code path can
 * uniformly read from roundtable_users instead of branching on include_user.
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

    // Backfill existing single-user roundtables
    await queryInterface.sequelize.query(`
      INSERT INTO roundtable_users (id, roundtable_id, user_id, turn_order, turns_completed, created_at)
      SELECT gen_random_uuid(), r.id, r.created_by, 0, 0, CURRENT_TIMESTAMP
      FROM roundtables r
      WHERE r.include_user = true
        AND NOT EXISTS (
          SELECT 1 FROM roundtable_users ru WHERE ru.roundtable_id = r.id
        )
    `);

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
