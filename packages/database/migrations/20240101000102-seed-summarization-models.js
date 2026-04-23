"use strict";

/**
 * Seeds the cheap summarisation models that `sessionSummarizationNode` pins
 * to per vendor. These are not chat models any agent picks directly — the
 * summariser uses them regardless of the agent's own modelId — but inserting
 * them into the `models` table keeps the schema consistent (FK lookups, admin
 * UI dropdowns, vendor reporting).
 *
 * Vendor IDs match the seeds in 20240101000014-seed-anthropic-google-models.js.
 *
 * @type {import('sequelize-cli').Migration}
 */

const ANTHROPIC_VENDOR_ID = "00000000-0000-4000-b000-000000000002";
const GOOGLE_VENDOR_ID = "00000000-0000-4000-b000-000000000003";

module.exports = {
  async up(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `INSERT INTO models (id, vendor_id, name, slug, created_at, updated_at) VALUES
        (gen_random_uuid(), :anthropic, 'Claude Haiku 4.5', 'claude-haiku-4-5', NOW(), NOW()),
        (gen_random_uuid(), :google,    'Gemini 2.0 Flash', 'gemini-2.0-flash', NOW(), NOW())
       ON CONFLICT (slug) DO NOTHING`,
      {
        replacements: {
          anthropic: ANTHROPIC_VENDOR_ID,
          google: GOOGLE_VENDOR_ID,
        },
      },
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `DELETE FROM models WHERE slug IN ('claude-haiku-4-5', 'gemini-2.0-flash')`,
    );
  },
};
