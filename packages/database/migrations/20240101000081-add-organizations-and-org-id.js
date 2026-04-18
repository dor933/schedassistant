"use strict";

/**
 * Multi-tenancy foundation.
 *
 * 1. Create the `organizations` table.
 * 2. Create a "Default" organization for all existing data.
 * 3. Add `organization_id` FK to `users` and `agents`.
 * 4. Backfill organization_id on existing rows.
 * 5. Lock the column NOT NULL.
 * 6. Swap the partial unique indexes on agents.definition / agents.slug
 *    from global to per-organization scope.
 *
 * Only `users` and `agents` carry `organization_id`. Everything else
 * (groups, single_chats, messages, projects, roundtables, etc.) is
 * already linked through these two, so scoping here isolates the
 * whole graph.
 *
 * @type {import('sequelize-cli').Migration}
 */

const DEFAULT_ORG_ID = "00000000-0000-4000-d000-000000000001";

module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. organizations table
    await queryInterface.createTable("organizations", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
        allowNull: false,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      slug: {
        type: Sequelize.STRING,
        allowNull: true,
        unique: true,
      },
      logo: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("NOW()"),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("NOW()"),
      },
    });

    // 2. Seed the default organization for pre-existing data.
    await queryInterface.sequelize.query(
      `INSERT INTO organizations (id, name, slug, created_at, updated_at)
       VALUES (CAST(:id AS uuid), 'Default', 'default', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      { replacements: { id: DEFAULT_ORG_ID } },
    );

    // 3. Add organization_id (nullable first so the backfill can run).
    await queryInterface.addColumn("users", "organization_id", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "organizations", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
    });
    await queryInterface.addColumn("agents", "organization_id", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "organizations", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
    });

    // 4. Backfill.
    await queryInterface.sequelize.query(
      `UPDATE users SET organization_id = CAST(:id AS uuid) WHERE organization_id IS NULL`,
      { replacements: { id: DEFAULT_ORG_ID } },
    );
    await queryInterface.sequelize.query(
      `UPDATE agents SET organization_id = CAST(:id AS uuid) WHERE organization_id IS NULL`,
      { replacements: { id: DEFAULT_ORG_ID } },
    );

    // 5. Enforce NOT NULL.
    await queryInterface.changeColumn("users", "organization_id", {
      type: Sequelize.UUID,
      allowNull: false,
      references: { model: "organizations", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
    });
    await queryInterface.changeColumn("agents", "organization_id", {
      type: Sequelize.UUID,
      allowNull: false,
      references: { model: "organizations", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
    });

    await queryInterface.addIndex("users", ["organization_id"], {
      name: "users_organization_id",
    });
    await queryInterface.addIndex("agents", ["organization_id"], {
      name: "agents_organization_id",
    });

    // 6. Partial unique indexes: global → per-organization.
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS agents_definition_unique`,
    );
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS agents_slug_unique`,
    );
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX agents_definition_org_unique
         ON agents(organization_id, definition)
         WHERE definition IS NOT NULL`,
    );
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX agents_slug_org_unique
         ON agents(organization_id, slug)
         WHERE slug IS NOT NULL`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS agents_definition_org_unique`,
    );
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS agents_slug_org_unique`,
    );
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX agents_definition_unique ON agents(definition) WHERE definition IS NOT NULL`,
    );
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX agents_slug_unique ON agents(slug) WHERE slug IS NOT NULL`,
    );

    await queryInterface.removeIndex("users", "users_organization_id");
    await queryInterface.removeIndex("agents", "agents_organization_id");

    await queryInterface.removeColumn("users", "organization_id");
    await queryInterface.removeColumn("agents", "organization_id");

    await queryInterface.dropTable("organizations");
  },
};
