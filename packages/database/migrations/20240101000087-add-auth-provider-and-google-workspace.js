"use strict";

/**
 * Just-in-time Google Workspace SSO.
 *
 * - users.auth_provider: 'local' | 'google'. 'local' keeps the password flow;
 *   'google' means the row was created (or upgraded) via Google SSO.
 * - users.external_sub: Google `sub` claim — stable, opaque user id from the
 *   provider. Pair (auth_provider, external_sub) is unique so re-logins find
 *   the existing row instead of creating duplicates.
 *
 * - organizations.google_workspace_domain: the `hd` claim on the Google id
 *   token, e.g. 'grahamy.com'. Unique — every domain maps to exactly one
 *   tenant. Currently one Google Cloud project backs every domain; in the
 *   future each org will get its own dedicated URL + OAuth client, which is
 *   why we also store google_client_id per org (nullable — falls back to the
 *   env-level client id list when unset).
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("users", "auth_provider", {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: "local",
    });
    await queryInterface.addColumn("users", "external_sub", {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX users_provider_sub_unique
         ON users(auth_provider, external_sub)
         WHERE external_sub IS NOT NULL`,
    );

    await queryInterface.addColumn("organizations", "google_workspace_domain", {
      type: Sequelize.STRING(255),
      allowNull: true,
      unique: true,
    });
    await queryInterface.addColumn("organizations", "google_client_id", {
      type: Sequelize.STRING(255),
      allowNull: true,
    });

    // Bootstrap the existing grahamy tenant so SSO works out of the box.
    // Looks up by slug or name — safe no-op if neither exists yet.
    await queryInterface.sequelize.query(`
      UPDATE organizations
         SET google_workspace_domain = 'grahamy.com'
       WHERE google_workspace_domain IS NULL
         AND (LOWER(slug) = 'grahamy' OR LOWER(name) = 'grahamy')
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("organizations", "google_client_id");
    await queryInterface.removeColumn("organizations", "google_workspace_domain");
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS users_provider_sub_unique`,
    );
    await queryInterface.removeColumn("users", "external_sub");
    await queryInterface.removeColumn("users", "auth_provider");
  },
};
