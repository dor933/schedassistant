"use strict";

const OPENAI_VENDOR_ID = "00000000-0000-4000-b000-000000000001";
const ANTHROPIC_VENDOR_ID = "00000000-0000-4000-b000-000000000002";
const GOOGLE_VENDOR_ID = "00000000-0000-4000-b000-000000000003";
const GPT4O_MODEL_ID = "00000000-0000-4000-c000-000000000001";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Create vendors table
    await queryInterface.createTable("vendors", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      name: { type: Sequelize.STRING, allowNull: false },
      slug: { type: Sequelize.STRING, allowNull: false, unique: true },
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

    // 2. Create models table
    await queryInterface.createTable("models", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      vendor_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "vendors", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      name: { type: Sequelize.STRING, allowNull: false },
      slug: { type: Sequelize.STRING, allowNull: false, unique: true },
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

    await queryInterface.addIndex("models", ["vendor_id"], {
      name: "models_vendor_id",
    });

    // 3. Seed vendors
    await queryInterface.sequelize.query(
      `INSERT INTO vendors (id, name, slug, created_at, updated_at) VALUES
        (:openai, 'OpenAI', 'openai', NOW(), NOW()),
        (:anthropic, 'Anthropic', 'anthropic', NOW(), NOW()),
        (:google, 'Google', 'google', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      {
        replacements: {
          openai: OPENAI_VENDOR_ID,
          anthropic: ANTHROPIC_VENDOR_ID,
          google: GOOGLE_VENDOR_ID,
        },
      },
    );

    // 4. Seed gpt-4o model
    await queryInterface.sequelize.query(
      `INSERT INTO models (id, vendor_id, name, slug, created_at, updated_at) VALUES
        (:id, :vendorId, 'GPT-4o', 'gpt-4o', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      {
        replacements: {
          id: GPT4O_MODEL_ID,
          vendorId: OPENAI_VENDOR_ID,
        },
      },
    );

  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.dropTable("models");
    await queryInterface.dropTable("vendors");
  },
};
