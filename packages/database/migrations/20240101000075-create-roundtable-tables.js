"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // ── roundtables ─────────────────────────────────────────────────────
    await queryInterface.createTable("roundtables", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      topic: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: "pending",
      },
      max_turns_per_agent: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 5,
      },
      current_round: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      current_agent_order_index: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      group_id: {
        type: Sequelize.UUID,
        allowNull: true,
      },
      single_chat_id: {
        type: Sequelize.UUID,
        allowNull: true,
      },
      thread_id: {
        type: Sequelize.UUID,
        allowNull: false,
      },
      created_by: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
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

    await queryInterface.sequelize.query(
      `ALTER TABLE roundtables ADD CONSTRAINT roundtables_status_check
       CHECK (status IN ('pending', 'running', 'completed', 'failed'))`,
    );

    await queryInterface.addIndex("roundtables", ["status"], {
      name: "roundtables_status",
    });
    await queryInterface.addIndex("roundtables", ["created_by"], {
      name: "roundtables_created_by",
    });

    // ── roundtable_agents ───────────────────────────────────────────────
    await queryInterface.createTable("roundtable_agents", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      roundtable_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "roundtables", key: "id" },
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
      turn_order: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      turns_completed: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
    });

    await queryInterface.addIndex("roundtable_agents", ["roundtable_id", "turn_order"], {
      name: "roundtable_agents_unique_order",
      unique: true,
    });
    await queryInterface.addIndex("roundtable_agents", ["roundtable_id"], {
      name: "roundtable_agents_roundtable_id",
    });

    // ── roundtable_messages ─────────────────────────────────────────────
    await queryInterface.createTable("roundtable_messages", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      roundtable_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "roundtables", key: "id" },
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
      round_number: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      content: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
    });

    await queryInterface.addIndex("roundtable_messages", ["roundtable_id"], {
      name: "roundtable_messages_roundtable_id",
    });
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeIndex("roundtable_messages", "roundtable_messages_roundtable_id");
    await queryInterface.dropTable("roundtable_messages");

    await queryInterface.removeIndex("roundtable_agents", "roundtable_agents_roundtable_id");
    await queryInterface.removeIndex("roundtable_agents", "roundtable_agents_unique_order");
    await queryInterface.dropTable("roundtable_agents");

    await queryInterface.removeIndex("roundtables", "roundtables_created_by");
    await queryInterface.removeIndex("roundtables", "roundtables_status");
    await queryInterface.sequelize.query(
      `ALTER TABLE roundtables DROP CONSTRAINT IF EXISTS roundtables_status_check`,
    );
    await queryInterface.dropTable("roundtables");
  },
};
