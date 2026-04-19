"use strict";

/**
 * Adds `users.last_login_at` — timestamp of this user's most recent successful
 * login. Used by the client to decide whether to play the cinematic "welcome"
 * launch animation (NULL → first login, show it; populated → normal sign-in).
 *
 * Covers both Google JIT-provisioned users and future admin-created local
 * users, so the welcome experience fires exactly once per person regardless of
 * how their account was created.
 *
 * Existing users are backfilled with `created_at` so they don't re-trigger
 * the animation on their next login.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("users", "last_login_at", {
      type: Sequelize.DATE,
      allowNull: true,
    });

    // Backfill existing rows — we have no real login history, but created_at
    // is a safe stand-in: it's non-null and anything non-null means
    // "don't play the welcome animation for this user".
    await queryInterface.sequelize.query(`
      UPDATE users
         SET last_login_at = created_at
       WHERE last_login_at IS NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("users", "last_login_at");
  },
};
