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
  },
};
