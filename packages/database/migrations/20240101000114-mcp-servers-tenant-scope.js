"use strict";

/**
 * Tenant-scope `mcp_servers`.
 *
 * Background: until now the registry was platform-wide and read-only in the
 * UI — the controller (`mcpServers.controller.ts`) explicitly refused
 * mutations because any super_admin in any tenant could clobber every
 * tenant's MCPs. With AdminPage gaining MCP CRUD we lift that restriction
 * by giving each row an owning org:
 *
 *   - `organization_id IS NULL` → platform-shared row, read-only in the UI,
 *     installable by any org via "copy to my org". Filesystem / fetch /
 *     github "well-known" servers live here, seeded out-of-band.
 *
 *   - `organization_id = X`     → owned by org X. Only super_admins of
 *     org X may edit/delete. Visible only to org X.
 *
 * `script_content` carries an inline node-runnable MCP server that admins
 * paste into the UI — the controller persists it under
 * `/home/agent/.codex/mcp-scripts/<id>.js` and points `command="node"`,
 * `args=["/home/agent/.codex/mcp-scripts/<id>.js"]`. Only super_admins can
 * create/edit script rows (enforced in the controller, not the DB).
 *
 * Uniqueness: name was globally unique. Now unique per org via partial
 * indexes — one for owned rows (`organization_id, name`), one for the
 * platform-shared null-org slot (just `name`).
 *
 * @type {import('sequelize-cli').Migration}
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("mcp_servers", "organization_id", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "organizations", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "CASCADE",
    });

    await queryInterface.addColumn("mcp_servers", "description", {
      type: Sequelize.TEXT,
      allowNull: true,
    });

    await queryInterface.addColumn("mcp_servers", "script_content", {
      type: Sequelize.TEXT,
      allowNull: true,
    });

    await queryInterface.addIndex("mcp_servers", ["organization_id"], {
      name: "mcp_servers_organization_id",
    });

    // Drop the global unique on name — has to come before the new partial
    // indexes or two rows with the same name across orgs would collide.
    // Sequelize names the auto-generated unique index either `mcp_servers_name_key`
    // (constraint-backed) or `mcp_servers_name`; the safe path is to remove
    // the constraint by name, which drops the backing index too.
    await queryInterface.sequelize.query(
      `ALTER TABLE mcp_servers DROP CONSTRAINT IF EXISTS mcp_servers_name_key`,
    );
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS mcp_servers_name_key`,
    );
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS mcp_servers_name`,
    );

    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX mcp_servers_org_name_unique
         ON mcp_servers(organization_id, name)
         WHERE organization_id IS NOT NULL`,
    );
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX mcp_servers_platform_name_unique
         ON mcp_servers(name)
         WHERE organization_id IS NULL`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS mcp_servers_org_name_unique`,
    );
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS mcp_servers_platform_name_unique`,
    );
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX mcp_servers_name_key ON mcp_servers(name)`,
    );

    await queryInterface.removeIndex(
      "mcp_servers",
      "mcp_servers_organization_id",
    );

    await queryInterface.removeColumn("mcp_servers", "script_content");
    await queryInterface.removeColumn("mcp_servers", "description");
    await queryInterface.removeColumn("mcp_servers", "organization_id");
  },
};
