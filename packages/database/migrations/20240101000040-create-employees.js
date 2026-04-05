"use strict";

/**
 * Creates the `employees` table — a second child of `persons`.
 *
 * A `person` can be a user, an employee, both, or neither. When the same
 * person holds both roles, `users.id`, `employees.id`, and `persons.id` are
 * all the same integer. Employment-specific fields (jira_id_number, …) live
 * here and are consumed by the tools that integrate with external systems.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("employees", {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        allowNull: false,
        references: { model: "persons", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      jira_id_number: {
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
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.dropTable("employees");
  },
};
