"use strict";

/**
 * Per-org embedding model + key enforcement (slice 15).
 *
 * Until now the embedder used a hardcoded `text-embedding-3-small`
 * (1536-dim) model and read the org's OpenAI api_key row. This migration
 * lets each org pick its own embedding model and (optionally) bill
 * embeddings to a dedicated key separate from chat completions.
 *
 *  1. Creates `embedding_models` — a small catalog table keyed by slug,
 *     with `dimension` carried as a hard fact about the model. Seeded
 *     with a sensible starter set: OpenAI 3-small/3-large, Voyage AI's
 *     `voyage-3-large`, and Cohere's `embed-english-v3.0`. Admins can
 *     extend by inserting rows; nothing else in the system enumerates
 *     this list.
 *
 *  2. Adds `embedding_model_id` and `embedding_dimension` to
 *     `organizations`. The dimension column is what *freezes* the org's
 *     choice — once set, the application layer refuses any switch that
 *     would change it (since the `episodic_memory.embedding` column is
 *     a fixed-size `vector(1536)` and dimension-mismatched rows would
 *     fail to insert). The escape hatch is "wipe and re-embed", deferred
 *     to a future job.
 *
 *  3. Extends `organization_vendor_api_keys.key_type` to allow
 *     `'embedding'`. The runtime resolver prefers an embedding-typed
 *     row but falls back to the same vendor's `api_key` row when none
 *     exists, so admins who only set one key for OpenAI keep working.
 *     The vendor_keys_key_type_valid CHECK constraint is replaced to
 *     include the new value.
 *
 * Both up steps are idempotent (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`),
 * so re-running the migration is safe.
 *
 * @type {import('sequelize-cli').Migration}
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    // ── 1. embedding_models catalog ────────────────────────────────────
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS embedding_models (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vendor_id UUID NOT NULL REFERENCES vendors(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        dimension INTEGER NOT NULL CHECK (dimension > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS embedding_models_vendor_idx
        ON embedding_models(vendor_id);
    `);

    // Resolve known vendor ids — only seed rows for vendors actually in
    // the catalog. Voyage / Cohere may not be there; skip silently when
    // their vendor row is missing.
    const [vendorRows] = await queryInterface.sequelize.query(
      `SELECT id, slug FROM vendors WHERE slug IN ('openai', 'voyage', 'cohere')`,
    );
    const vendorBySlug = new Map(vendorRows.map((r) => [r.slug, r.id]));

    const seeds = [
      {
        slug: "text-embedding-3-small",
        name: "OpenAI text-embedding-3-small",
        dimension: 1536,
        vendorSlug: "openai",
      },
      {
        slug: "text-embedding-3-large",
        name: "OpenAI text-embedding-3-large",
        dimension: 3072,
        vendorSlug: "openai",
      },
      {
        slug: "voyage-3-large",
        name: "Voyage AI voyage-3-large",
        dimension: 1024,
        vendorSlug: "voyage",
      },
      {
        slug: "embed-english-v3.0",
        name: "Cohere embed-english-v3.0",
        dimension: 1024,
        vendorSlug: "cohere",
      },
    ];
    for (const s of seeds) {
      const vendorId = vendorBySlug.get(s.vendorSlug);
      if (!vendorId) continue;
      await queryInterface.sequelize.query(
        `INSERT INTO embedding_models (id, vendor_id, slug, name, dimension, created_at, updated_at)
         VALUES (gen_random_uuid(), CAST(:vendorId AS uuid), :slug, :name, :dim, NOW(), NOW())
         ON CONFLICT (slug) DO NOTHING`,
        {
          replacements: {
            vendorId,
            slug: s.slug,
            name: s.name,
            dim: s.dimension,
          },
        },
      );
    }

    // ── 2. organizations.embedding_model_id / embedding_dimension ──────
    await queryInterface.sequelize.query(`
      ALTER TABLE organizations
        ADD COLUMN IF NOT EXISTS embedding_model_id UUID
          REFERENCES embedding_models(id) ON UPDATE CASCADE ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS embedding_dimension INTEGER;
    `);
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS organizations_embedding_model_id_idx
        ON organizations(embedding_model_id);
    `);

    // ── 3. organization_vendor_api_keys: extend key_type enum ──────────
    // Replace the existing CHECK constraint (added in migration 127).
    // Drop-then-add so the new value is permitted; safe because the
    // column data already conforms (we are only widening the allowed
    // set).
    await queryInterface.sequelize.query(`
      ALTER TABLE organization_vendor_api_keys
        DROP CONSTRAINT IF EXISTS vendor_keys_key_type_valid;
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE organization_vendor_api_keys
        ADD CONSTRAINT vendor_keys_key_type_valid
          CHECK (key_type IN ('api_key', 'oauth_token', 'auth_object', 'embedding'));
    `);
  },

  async down(queryInterface, _Sequelize) {
    // Revert the key_type CHECK constraint to the pre-129 set. We
    // intentionally leave any 'embedding' rows behind — deleting them
    // would silently drop credentials. Re-running up restores the
    // wider constraint.
    await queryInterface.sequelize.query(`
      ALTER TABLE organization_vendor_api_keys
        DROP CONSTRAINT IF EXISTS vendor_keys_key_type_valid;
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE organization_vendor_api_keys
        ADD CONSTRAINT vendor_keys_key_type_valid
          CHECK (key_type IN ('api_key', 'oauth_token', 'auth_object'));
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE organizations
        DROP COLUMN IF EXISTS embedding_model_id,
        DROP COLUMN IF EXISTS embedding_dimension;
    `);

    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS embedding_models;`);
  },
};
