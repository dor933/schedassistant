"use strict";

/**
 * Creates the `persons` parent table and the `users` child table.
 *
 * `persons` holds identity shared across all roles someone might take in the
 * system (user, employee, …). Both `users.id` and `employees.id` are *also*
 * foreign keys pointing at `persons.id`, so the same integer id identifies
 * the person across every role table they belong to.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // ─── persons (parent) ──────────────────────────────────────────────────
    await queryInterface.createTable("persons", {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      first_name: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      last_name: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      email: {
        type: Sequelize.STRING,
        allowNull: true,
        unique: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
    });

    // ─── users (child; id IS persons.id) ───────────────────────────────────
    await queryInterface.createTable("users", {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        allowNull: false,
        references: { model: "persons", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      external_ref: {
        type: Sequelize.STRING,
        unique: true,
        allowNull: true,
      },
      display_name: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      user_identity: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
    });
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.dropTable("users");
    await queryInterface.dropTable("persons");
  },
};
