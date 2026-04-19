"use strict";

/**
 * Seed the initial platform admin ("systemadmin") — the single principal
 * allowed to manage platform-wide catalogs (MCP servers, skills, models,
 * vendor API keys) via the `/platform-admin` UI.
 *
 * Platform admins live in their own table (`platform_admins`) created by
 * migration 91 and are intentionally disjoint from tenant `users`.
 *
 * Credentials are read from env vars at migrate-time — we never commit a
 * hashed password. If the env vars are missing, the migration skips cleanly
 * so local dev can seed via `apps/user_app/scripts/create-platform-admin.ts`
 * instead.
 *
 *   PLATFORM_ADMIN_EMAIL=systemadmin@company.com
 *   PLATFORM_ADMIN_PASSWORD='strong-password-12+chars'
 *
 * Idempotent: upserts on email, so re-running rotates the password hash.
 *
 * @type {import('sequelize-cli').Migration}
 */

const bcrypt = require("bcrypt");

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

    const passwordHash = await bcrypt.hash(password, 12);

    // Upsert on unique email. sequelize-cli gives us a raw queryInterface, so
    // we do the upsert via raw SQL rather than model methods.
    await queryInterface.sequelize.query(
      `INSERT INTO platform_admins (email, password_hash, created_at, updated_at)
       VALUES (:email, :passwordHash, NOW(), NOW())
       ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             updated_at = NOW()`,
      { replacements: { email, passwordHash } },
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
