"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("message_notifications", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      thread_id: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      recipient_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      sender_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      message_id: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      preview: {
        type: Sequelize.STRING(300),
        allowNull: true,
      },
      status: {
        type: Sequelize.ENUM("delivered", "seen"),
        allowNull: false,
        defaultValue: "delivered",
      },
      conversation_id: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      conversation_type: {
        type: Sequelize.ENUM("group", "single"),
        allowNull: false,
      },
      delivered_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
      seen_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });

    await queryInterface.addIndex(
      "message_notifications",
      ["recipient_id", "status"],
      { name: "msg_notif_recipient_status" },
    );
    await queryInterface.addIndex(
      "message_notifications",
      ["recipient_id", "conversation_id"],
      { name: "msg_notif_recipient_conversation" },
    );
    await queryInterface.addIndex(
      "message_notifications",
      ["message_id"],
      { name: "msg_notif_message_id" },
    );
    await queryInterface.addIndex(
      "message_notifications",
      ["thread_id"],
      { name: "msg_notif_thread_id" },
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.dropTable("message_notifications");
  },
};
