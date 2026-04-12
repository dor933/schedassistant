"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("deep_agent_delegations", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      caller_agent_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "agents", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      executor_agent_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "agents", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      request: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      result: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: "pending",
      },
      group_id: {
        type: Sequelize.UUID,
        allowNull: true,
      },
      single_chat_id: {
        type: Sequelize.UUID,
        allowNull: true,
      },
      error: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
      completed_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });

    await queryInterface.addIndex("deep_agent_delegations", ["caller_agent_id"], {
      name: "deep_agent_delegations_caller_agent_id",
    });

    await queryInterface.addIndex("deep_agent_delegations", ["status"], {
      name: "deep_agent_delegations_status",
    });
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeIndex("deep_agent_delegations", "deep_agent_delegations_status");
    await queryInterface.removeIndex("deep_agent_delegations", "deep_agent_delegations_caller_agent_id");
    await queryInterface.dropTable("deep_agent_delegations");
  },
};
