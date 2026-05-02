"use strict";

/**
 * Adds `key_type` to `organization_vendor_api_keys` so each per-org credential
 * row carries an explicit kind — currently `'api_key'` or `'oauth_token'`.
 *
 * Why:
 *   - Anthropic supports two distinct credential formats: classic API keys
 *     (`sk-ant-api…`) and Claude Code OAuth tokens (`sk-ant-oat…`). They
 *     route to different env vars in the SDK (`ANTHROPIC_API_KEY` vs
 *     `CLAUDE_CODE_OAUTH_TOKEN`) and cannot be auto-detected reliably from
 *     prefix alone (rotated tokens, future formats, etc.).
 *   - Storing the kind alongside the value lets the runtime pick the right
 *     env var deterministically, and lets the admin UI render an explicit
 *     selector instead of guessing.
 *
 * Index strategy:
 *   - Drops the existing `(organization_id, vendor_id)` UNIQUE index — that
 *     constraint forced one credential per (org, vendor) which prevented
 *     storing both an API key and an OAuth token for the same Anthropic
 *     org row.
 *   - Replaces it with a UNIQUE index on `(organization_id, vendor_id,
 *     key_type)` so:
 *       * Each (org, vendor, key_type) tuple still has at most one row
 *         (no accidental duplicates from the admin UI).
 *       * The same (org, vendor) pair may carry one row per `key_type` —
 *         leaving room to support both formats simultaneously.
 *
 * Backfill: existing rows are migrated to `'api_key'` because that was the
 * only credential type the column ever held. Admins can flip a row to
 * `'oauth_token'` later via the admin UI without a data migration.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Add the new column nullable so existing rows survive the ALTER.
    await queryInterface.addColumn("organization_vendor_api_keys", "key_type", {
      type: Sequelize.STRING,
      allowNull: true,
    });

    // 2. Backfill — every legacy row stored a classic API key.
    await queryInterface.sequelize.query(
      `UPDATE organization_vendor_api_keys SET key_type = 'api_key' WHERE key_type IS NULL`,
    );

    // 3. Enforce NOT NULL + the allowed-values check.
    await queryInterface.sequelize.query(
      `ALTER TABLE organization_vendor_api_keys
         ALTER COLUMN key_type SET NOT NULL`,
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE organization_vendor_api_keys
         ADD CONSTRAINT organization_vendor_api_keys_key_type_check
         CHECK (key_type IN ('api_key', 'oauth_token'))`,
    );

    // 4. Swap the unique index from (org, vendor) → (org, vendor, key_type).
    await queryInterface.removeIndex(
      "organization_vendor_api_keys",
      "organization_vendor_api_keys_org_vendor_unique",
    );
    await queryInterface.addIndex("organization_vendor_api_keys", {
      fields: ["organization_id", "vendor_id", "key_type"],
      unique: true,
      name: "organization_vendor_api_keys_org_vendor_type_unique",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      "organization_vendor_api_keys",
      "organization_vendor_api_keys_org_vendor_type_unique",
    );
    // Restore the original unique constraint. If the table now contains two
    // rows for the same (org, vendor) — one api_key and one oauth_token —
    // this re-add will fail; the operator must manually delete one before
    // rolling back.
    await queryInterface.addIndex("organization_vendor_api_keys", {
      fields: ["organization_id", "vendor_id"],
      unique: true,
      name: "organization_vendor_api_keys_org_vendor_unique",
    });
    await queryInterface.sequelize.query(
      `ALTER TABLE organization_vendor_api_keys
         DROP CONSTRAINT IF EXISTS organization_vendor_api_keys_key_type_check`,
    );
    await queryInterface.removeColumn("organization_vendor_api_keys", "key_type");
  },
};
