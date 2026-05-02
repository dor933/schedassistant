"use strict";

/**
 * Slice 14 — per-org Codex auth.json storage.
 *
 * Why
 * ---
 * Codex CLI's ChatGPT-account login is a structured object (id_token,
 * access_token, refresh_token, account_id, last_refresh, optional
 * OPENAI_API_KEY) — not a single string. We previously persisted it as
 * `~/.codex/auth.json` on a host filesystem path that was NOT mounted
 * on a docker volume, so every container rebuild wiped it. This
 * migration moves the storage into the existing per-org credentials
 * table as a `JSONB` column, alongside the existing simple-string
 * `api_key` row.
 *
 * Schema changes on `organization_vendor_api_keys`
 * ------------------------------------------------
 * 1. Add `auth_object JSONB NULL` — holds the full Codex auth.json
 *    object when the row's credential is multi-field. Nullable so
 *    rows storing a simple `api_key` string don't have to populate it.
 * 2. Drop the NOT NULL on `api_key`. Rows that store an `auth_object`
 *    have NULL there; the existing simple-key rows keep their string.
 * 3. Add CHECK constraint: exactly one of `api_key` / `auth_object`
 *    is non-null per row. Prevents accidentally landing a row with
 *    both populated (admin would never know which the runner picked)
 *    or neither populated (a useless empty credential).
 * 4. Extend the `key_type` validation to allow `'auth_object'`. The
 *    column itself is already a free-form VARCHAR — Sequelize-level
 *    validation enforces the enum; no DDL change needed for that.
 *    The check constraint here also enforces it at the DB level so a
 *    direct INSERT can't bypass the discriminator.
 *
 * Idempotent — re-running is a no-op (column add is guarded, constraint
 * names are conditional).
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tx = await queryInterface.sequelize.transaction();
    try {
      // 1. Add `auth_object` (JSONB, nullable). Idempotent: if it
      //    already exists, skip — Postgres will throw on duplicate
      //    column otherwise, which is fine for fresh installs but
      //    breaks re-running on a mid-state DB.
      await queryInterface.sequelize.query(
        `ALTER TABLE organization_vendor_api_keys
            ADD COLUMN IF NOT EXISTS auth_object JSONB NULL`,
        { transaction: tx },
      );

      // 2. Relax the NOT NULL on `api_key`. Existing rows are unaffected
      //    (they still have non-null values); future rows storing
      //    auth_object can leave it NULL.
      await queryInterface.changeColumn(
        "organization_vendor_api_keys",
        "api_key",
        {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        { transaction: tx },
      );

      // 3. Exactly-one-credential CHECK. Prevents NULL + NULL or
      //    non-NULL + non-NULL rows from ever existing.
      await queryInterface.sequelize.query(
        `ALTER TABLE organization_vendor_api_keys
           DROP CONSTRAINT IF EXISTS vendor_keys_one_credential_per_row`,
        { transaction: tx },
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE organization_vendor_api_keys
           ADD CONSTRAINT vendor_keys_one_credential_per_row
           CHECK (
             (api_key IS NOT NULL AND auth_object IS NULL) OR
             (api_key IS NULL     AND auth_object IS NOT NULL)
           )`,
        { transaction: tx },
      );

      // 4. Discriminator CHECK on key_type. Three valid values; an
      //    auth_object row MUST be `key_type='auth_object'`, the
      //    simple-string rows keep their existing values.
      await queryInterface.sequelize.query(
        `ALTER TABLE organization_vendor_api_keys
           DROP CONSTRAINT IF EXISTS vendor_keys_key_type_valid`,
        { transaction: tx },
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE organization_vendor_api_keys
           ADD CONSTRAINT vendor_keys_key_type_valid
           CHECK (
             key_type IN ('api_key', 'oauth_token', 'auth_object')
             AND (
               (key_type = 'auth_object' AND auth_object IS NOT NULL AND api_key IS NULL)
               OR
               (key_type IN ('api_key', 'oauth_token') AND api_key IS NOT NULL AND auth_object IS NULL)
             )
           )`,
        { transaction: tx },
      );

      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  },

  async down(queryInterface, Sequelize) {
    const tx = await queryInterface.sequelize.transaction();
    try {
      // Drop both CHECKs first so the column changes underneath them
      // don't trip the constraint validator.
      await queryInterface.sequelize.query(
        `ALTER TABLE organization_vendor_api_keys
           DROP CONSTRAINT IF EXISTS vendor_keys_key_type_valid`,
        { transaction: tx },
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE organization_vendor_api_keys
           DROP CONSTRAINT IF EXISTS vendor_keys_one_credential_per_row`,
        { transaction: tx },
      );

      // Delete any auth_object-only rows because we can't restore the
      // NOT NULL on api_key while they exist.
      await queryInterface.sequelize.query(
        `DELETE FROM organization_vendor_api_keys WHERE api_key IS NULL`,
        { transaction: tx },
      );

      await queryInterface.changeColumn(
        "organization_vendor_api_keys",
        "api_key",
        {
          type: Sequelize.TEXT,
          allowNull: false,
        },
        { transaction: tx },
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE organization_vendor_api_keys
           DROP COLUMN IF EXISTS auth_object`,
        { transaction: tx },
      );

      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  },
};
