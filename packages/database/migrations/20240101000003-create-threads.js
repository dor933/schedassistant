"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("threads", {
      id: {
        type: Sequelize.STRING,
        primaryKey: true,
        allowNull: false,
      },
      user_id: {
        type: Sequelize.STRING,
        allowNull: true,
        references: { model: "users", key: "id" },
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
      archived_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      last_activity_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      ttl_expires_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      summarized_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      summary: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      checkpoint_size_bytes: {
        type: Sequelize.BIGINT,
        allowNull: true,
      },
    });

    await queryInterface.addIndex("threads", ["user_id"], {
      name: "threads_user_id",
    });
    await queryInterface.addIndex(
      "threads",
      ["user_id", "summarized_at"],
      { name: "threads_user_id_summarized_at" },
    );
    await queryInterface.addIndex(
      "threads",
      ["user_id", "updated_at"],
      { name: "threads_user_id_updated_at" },
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.dropTable("threads");
  },
};
