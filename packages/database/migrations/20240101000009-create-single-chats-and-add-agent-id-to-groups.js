"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Create single_chats table
    await queryInterface.createTable("single_chats", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      agent_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "agents", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      title: {
        type: Sequelize.STRING,
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

    await queryInterface.addIndex("single_chats", ["user_id"], {
      name: "single_chats_user_id",
    });
    await queryInterface.addIndex("single_chats", ["agent_id"], {
      name: "single_chats_agent_id",
    });
    await queryInterface.addIndex("single_chats", ["user_id", "agent_id"], {
      unique: true,
      name: "single_chats_user_id_agent_id_unique",
    });

    // 2. Add agent_id to groups
    await queryInterface.addColumn("groups", "agent_id", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "agents", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    });

    await queryInterface.addIndex("groups", ["agent_id"], {
      name: "groups_agent_id",
    });
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeIndex("groups", "groups_agent_id");
    await queryInterface.removeColumn("groups", "agent_id");

    await queryInterface.dropTable("single_chats");
  },
};
