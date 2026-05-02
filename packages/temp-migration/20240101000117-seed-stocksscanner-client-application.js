"use strict";

/**
 * Seed the `client_applications` row representing StocksScanner.
 *
 * Required for the `/api/ask-grahamy` and `/api/application/:agentId/invoke`
 * routes — both JIT-resolve external user ids via `resolveOrCreateClientUser`
 * which scopes lookups by `client_applications.id`. The id is hard-coded so
 * the operator can paste it into the agent_service compose env without a
 * post-migration SELECT step:
 *
 *   DEFAULT_CLIENT_APPLICATION_ID: c1a40b38-9f6a-4b89-aab2-d51f6f68a1e2
 *
 * Idempotent — `ON CONFLICT (slug) DO NOTHING` so re-running the migrate
 * step on a healthy environment is a no-op (`slug` carries the unique
 * index `client_applications_slug_unique`).
 *
 * @type {import('sequelize-cli').Migration}
 */

const STOCKSSCANNER_CLIENT_APP_ID = "c1a40b38-9f6a-4b89-aab2-d51f6f68a1e2";
const GRAHAMY_ORG_ID = "acf0cbab-3aed-42cf-872d-63cba24e61c3";

module.exports = {
  async up(queryInterface) {
    // Ensure the Grahamy organization row exists. On a fresh environment the
    // only seeded org from migration `…081` is `Default`, which the
    // StocksScanner client_applications row's FK does not point at — so the
    // INSERT below would fail with `violates foreign key constraint`. Seeding
    // it here is idempotent (`ON CONFLICT (id) DO NOTHING`) so re-runs and
    // environments where the org was already created out-of-band are a no-op.
    await queryInterface.sequelize.query(
      `INSERT INTO organizations (id, name, slug, created_at, updated_at)
       VALUES (CAST(:id AS uuid), :name, :slug, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      {
        replacements: {
          id: GRAHAMY_ORG_ID,
          name: "Grahamy",
          slug: "grahamy",
        },
      },
    );

    await queryInterface.sequelize.query(
      `INSERT INTO client_applications
         (id, organization_id, name, slug, api_token_hash, created_at, updated_at)
       VALUES
         (:id, :orgId, :name, :slug, NULL, NOW(), NOW())
       ON CONFLICT (slug) DO NOTHING`,
      {
        replacements: {
          id: STOCKSSCANNER_CLIENT_APP_ID,
          orgId: GRAHAMY_ORG_ID,
          name: "StocksScanner",
          slug: "stocksscanner",
        },
      },
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DELETE FROM client_applications WHERE slug = :slug`,
      { replacements: { slug: "stocksscanner" } },
    );
    // Intentionally do NOT delete the Grahamy organization on rollback —
    // it likely owns agents, users, threads, and other rows that would
    // cascade-fail or orphan if removed. Manual cleanup if truly needed.
  },
};
