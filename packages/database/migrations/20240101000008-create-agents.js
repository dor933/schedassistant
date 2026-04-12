"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_AGENT_ID = "00000000-0000-4000-a000-000000000001";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Create the enum type first
    await queryInterface.sequelize.query(
      `CREATE TYPE "enum_agents_type" AS ENUM ('primary', 'system')`,
    );

    await queryInterface.createTable("agents", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      type: {
        type: Sequelize.ENUM("primary", "system"),
        allowNull: false,
        defaultValue: "primary",
      },
      definition: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      slug: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      agent_name: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      core_instructions: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      instructions: {
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
      created_by_user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      model_id: {
        type: Sequelize.UUID,
        allowNull: true,
        // FK added in 0012 after the models table exists
      },
      model_slug: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      tool_config: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      agent_notes: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      workspace_path: {
        type: Sequelize.TEXT,
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

    // Partial unique indexes
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX agents_definition_unique ON agents(definition) WHERE definition IS NOT NULL`,
    );
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX agents_slug_unique ON agents(slug) WHERE slug IS NOT NULL`,
    );

    await queryInterface.addIndex("agents", ["created_at"], {
      name: "agents_created_at",
    });
    await queryInterface.addIndex("agents", ["active_thread_id"], {
      name: "agents_active_thread_id",
    });
    await queryInterface.addIndex("agents", ["type"], {
      name: "agents_type",
    });

    // Seed the default primary agent
    const corePath = path.join(__dirname, "../../../apps/core_instructions/projectManager.json");
    const raw = JSON.parse(fs.readFileSync(corePath, "utf8"));
    const { description, core_description, characteristics } = raw;
    const charsJson = JSON.stringify(
      characteristics != null && typeof characteristics === "object"
        ? characteristics
        : {},
    );

    await queryInterface.sequelize.query(
      `INSERT INTO agents (id, type, definition, core_instructions, characteristics, active_thread_id, created_at, updated_at)
       VALUES (CAST(:id AS uuid), 'primary', :def, :core, CAST(:chars AS jsonb), NULL, NOW(), NOW())
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
    await queryInterface.removeIndex("agents", "agents_type");
    await queryInterface.removeIndex("agents", "agents_active_thread_id");
    await queryInterface.removeIndex("agents", "agents_created_at");
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS agents_definition_unique`);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS agents_slug_unique`);
    await queryInterface.dropTable("agents");
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_agents_type"`);
  },
};
