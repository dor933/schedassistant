"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_AGENT_ID = "00000000-0000-4000-a000-000000000001";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("agents", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      definition: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      core_instructions: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      characteristics: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      active_thread_id: {
        type: Sequelize.STRING,
        allowNull: true,
        references: { model: "threads", key: "id" },
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

    await queryInterface.addIndex("agents", ["created_at"], {
      name: "agents_created_at",
    });

    await queryInterface.addIndex("agents", ["active_thread_id"], {
      name: "agents_active_thread_id",
    });

    const corePath = path.join(__dirname, "../../../apps/coreInstructions.json");
    const raw = JSON.parse(fs.readFileSync(corePath, "utf8"));
    const { description, core_description, characteristics } = raw;
    const charsJson = JSON.stringify(
      characteristics != null && typeof characteristics === "object"
        ? characteristics
        : {},
    );

    await queryInterface.sequelize.query(
      `INSERT INTO agents (id, definition, core_instructions, characteristics, active_thread_id, created_at, updated_at)
       VALUES (CAST(:id AS uuid), :def, :core, CAST(:chars AS jsonb), NULL, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         definition = EXCLUDED.definition,
         core_instructions = EXCLUDED.core_instructions,
         characteristics = EXCLUDED.characteristics,
         updated_at = NOW()`,
      {
        replacements: {
          id: DEFAULT_AGENT_ID,
          def: description,
          core: core_description,
          chars: charsJson,
        },
      },
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeIndex("agents", "agents_active_thread_id");
    await queryInterface.removeIndex("agents", "agents_created_at");
    await queryInterface.dropTable("agents");
  },
};
