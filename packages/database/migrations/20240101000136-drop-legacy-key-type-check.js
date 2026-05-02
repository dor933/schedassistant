"use strict";

/**
 * Drops the legacy `organization_vendor_api_keys_key_type_check`
 * constraint from migration 120.
 *
 * Why this was needed:
 *   Migration 120 added `key_type` with `CHECK (key_type IN ('api_key',
 *   'oauth_token'))`. Migration 127 (slice 14) introduced
 *   `auth_object` and added a SECOND CHECK constraint
 *   (`vendor_keys_key_type_valid`) widening the allowed values to
 *   include it — but did NOT drop migration 120's narrow constraint.
 *   Migration 129 (slice 15) widened the second constraint further to
 *   include `embedding`, again without touching the legacy one.
 *
 *   Result: both CHECK constraints coexisted on the table. Inserts had
 *   to satisfy BOTH, so any row with `key_type IN ('auth_object',
 *   'embedding')` was rejected by the legacy constraint even though
 *   the modern one accepted it. The bug surfaced the first time an
 *   admin uploaded an `auth.json` blob (Codex CLI ChatGPT-account
 *   login) — Postgres rejected the INSERT with:
 *
 *     ERROR: new row for relation "organization_vendor_api_keys"
 *     violates check constraint "organization_vendor_api_keys_key_type_check"
 *
 *   This migration retires the legacy constraint. The
 *   `vendor_keys_key_type_valid` constraint (current allowed set:
 *   api_key, oauth_token, auth_object, embedding) is the sole gate
 *   afterwards — same enforcement, no overlap.
 *
 * Idempotent — `DROP CONSTRAINT IF EXISTS` is a no-op when the
 * constraint is already absent (e.g. on a fresh DB where this fix has
 * already been applied, or in test setups that recreated the schema
 * differently).
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `ALTER TABLE organization_vendor_api_keys
         DROP CONSTRAINT IF EXISTS organization_vendor_api_keys_key_type_check`,
    );
  },

  async down(queryInterface, _Sequelize) {
    // Restore the legacy NARROW constraint. After this rolls back, any
    // existing row with key_type IN ('auth_object', 'embedding') will
    // cause the ADD CONSTRAINT to fail — operators must clean those
    // rows up first if they need to roll back through this migration.
    await queryInterface.sequelize.query(
      `ALTER TABLE organization_vendor_api_keys
         ADD CONSTRAINT organization_vendor_api_keys_key_type_check
         CHECK (key_type IN ('api_key', 'oauth_token'))`,
    );
  },
};
