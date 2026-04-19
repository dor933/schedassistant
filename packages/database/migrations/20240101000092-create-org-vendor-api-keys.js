"use strict";

/**
 * Per-organization vendor API keys.
 *
 * Vendor API keys used to live as a single row on `vendors.api_key` — a
 * platform-wide shared credential. That breaks the tenant model: every org
 * now brings its own OpenAI / Anthropic / Google credentials, and
 * super_admins of one org must never be able to burn another org's quota
 * (or see another org's secret).
 *
 * The `vendors.api_key` column is dropped in migration 93 once this table
 * is in place. The LLM resolution path is rewritten to look up the key by
 * `(agent.organizationId, vendor.id)` instead.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("organization_vendor_api_keys", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
        allowNull: false,
      },
      organization_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "organizations", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      vendor_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "vendors", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      api_key: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("NOW()"),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("NOW()"),
      },
    });

    // One key per (org, vendor) — set/rotate/clear is always an upsert on
    // this composite, never a second row.
    await queryInterface.addIndex("organization_vendor_api_keys", {
      fields: ["organization_id", "vendor_id"],
      unique: true,
      name: "organization_vendor_api_keys_org_vendor_unique",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("organization_vendor_api_keys");
  },
};
