"use strict";

/**
 * Drop the legacy `vendors.api_key` column.
 *
 * Vendor API keys are now per-organization — see the `organization_vendor_api_keys`
 * table created by migration 92. Leaving the old global column around would
 * let stale code silently resolve a cross-tenant credential, which is the
 * exact failure mode this refactor removes.
 *
 * We intentionally do NOT backfill the old global value into every
 * organization's row. Platform-wide credentials were only ever a bootstrap
 * shortcut; each tenant now uploads their own.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.removeColumn("vendors", "api_key");
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn("vendors", "api_key", {
      type: Sequelize.TEXT,
      allowNull: true,
      defaultValue: null,
    });
  },
};
