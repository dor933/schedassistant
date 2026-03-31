"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("groups", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
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

    await queryInterface.addIndex("groups", ["name"], {
      name: "groups_name",
    });

    await queryInterface.createTable("group_members", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      group_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "groups", key: "id" },
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
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
    });

    await queryInterface.addIndex("group_members", ["group_id", "user_id"], {
      unique: true,
      name: "group_members_group_id_user_id_unique",
    });
    await queryInterface.addIndex("group_members", ["group_id"], {
      name: "group_members_group_id",
    });
    await queryInterface.addIndex("group_members", ["user_id"], {
      name: "group_members_user_id",
    });

    // LangGraph checkpoint thread id is canonical on `agents.active_thread_id`.
    // `threads` rows reference `agents.id` via `threads.agent_id` when created.
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.dropTable("group_members");
    await queryInterface.dropTable("groups");
  },
};
