"use strict";

/**
 * Seed the initial platform admin ("systemadmin") — the single principal
 * allowed to manage platform-wide catalogs (MCP servers, skills, models,
 * vendor API keys) via the `/platform-admin` UI.
 *
 * Platform admins live in their own table (`platform_admins`) created by
 * migration 23 and are intentionally disjoint from tenant `users`.
 *
 * Credentials are read from env vars at migrate-time — we never commit a
 * hashed password. If the env vars are missing, the migration skips cleanly
 * so local dev can seed via `apps/user_app/scripts/create-platform-admin.ts`
 * instead.
 *
 *   PLATFORM_ADMIN_EMAIL=systemadmin@company.com
 *   PLATFORM_ADMIN_PASSWORD='strong-password-12+chars'
 *
 * The password hash is produced by Postgres's `pgcrypto` (`crypt` +
 * `gen_salt('bf', 12)`), which emits a standard `$2a$12$…` bcrypt string
 * that Node's `bcrypt.compare` verifies at login. We use pgcrypto rather
 * than requiring the `bcrypt` node module so this migration can run in
 * minimal migrate containers that only install `packages/database` deps.
 *
 * Idempotent: upserts on email, so re-running rotates the password hash.
 *
 * @type {import('sequelize-cli').Migration}
 */

module.exports = {
  async up(queryInterface, _Sequelize) {
    const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.PLATFORM_ADMIN_PASSWORD;

    if (!email || !password) {
      console.log(
        "[migration 26] PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD not set — " +
          "skipping platform-admin seed. Run scripts/create-platform-admin.ts to seed later.",
      );
      return;
    }

    if (password.length < 12) {
      // Platform admins bypass every tenant boundary; a weak credential here
      // is worse than for any tenant user. Hard-fail rather than silently
      // accept something that will get compromised.
      throw new Error(
        "[migration 26] PLATFORM_ADMIN_PASSWORD must be at least 12 characters.",
      );
    }

    // pgcrypto provides `crypt()` + `gen_salt('bf', cost)` for bcrypt hashes.
    // Safe to run repeatedly (extension may already exist from pgvector/UUID setup).
    await queryInterface.sequelize.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    // Hash server-side and upsert on unique email.
    await queryInterface.sequelize.query(
      `INSERT INTO platform_admins (email, password_hash, created_at, updated_at)
       VALUES (:email, crypt(:password, gen_salt('bf', 12)), NOW(), NOW())
       ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             updated_at = NOW()`,
      { replacements: { email, password } },
    );

    console.log(`[migration 26] Seeded platform admin: ${email}`);
  },

  async down(queryInterface, _Sequelize) {
    const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
    if (!email) return;
    await queryInterface.sequelize.query(
      `DELETE FROM platform_admins WHERE email = :email`,
      { replacements: { email } },
    );
  },
};
