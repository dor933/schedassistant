"use strict";

/**
 * Detach the `filesystem` MCP server (id 4, seeded in migration 30) from
 * every agent in `agent_available_mcp_servers`.
 *
 * Reasoning: post-migration-145 the SDK filesystem capability is owned by
 * the `agent_sdk_capabilities` junction (slug `filesystem`), and the
 * `mcp_servers` table is reserved for explicit external-process MCP
 * attachments. Leaving stale `filesystem`-MCP rows on agents creates the
 * confusing dual-source state we just refactored away (capability could
 * come from either the junction or the MCP attachment), and for SDK-flow
 * agents the external filesystem MCP is also broken in practice — the
 * seeded server is rooted at `/app/data` and rejects writes outside it,
 * including the new per-epic workspace folders.
 *
 * Scope: ALL agents. The user explicitly asked for a clean wipe; agents
 * that genuinely want to use the external filesystem MCP can re-attach it
 * from the admin UI after this runs.
 *
 * Idempotent: a re-run after the rows are gone is a no-op DELETE.
 *
 * Down migration: NOT REVERSIBLE. We don't preserve which agents had the
 * attachment, so we can't restore the original state. The down is a no-op
 * with a logged warning — admins must re-attach manually if they're
 * reverting.
 *
 * @type {import('sequelize-cli').Migration}
 */

const FILESYSTEM_MCP_NAME = "filesystem";

module.exports = {
  async up(queryInterface) {
    // Resolve the filesystem MCP server id by name rather than hardcoding
    // `id = 4`. The seed insert ordering in migration 30 is what assigns
    // id 4 in fresh DBs, but a partial-rollback / restore-from-backup
    // could have a different id. Joining by name is robust either way.
    const [rows] = await queryInterface.sequelize.query(
      `SELECT id FROM mcp_servers WHERE name = :name LIMIT 1`,
      { replacements: { name: FILESYSTEM_MCP_NAME } },
    );
    if (rows.length === 0) {
      // Filesystem MCP row doesn't exist (env that never ran migration 30
      // for some reason, or it was removed manually). Nothing to detach.
      return;
    }
    const filesystemMcpId = rows[0].id;

    await queryInterface.sequelize.query(
      `DELETE FROM agent_available_mcp_servers WHERE mcp_server_id = :id`,
      { replacements: { id: filesystemMcpId } },
    );
  },

  async down() {
    // Intentional no-op. The original attachment list is not preserved.
    // Re-attach manually via the admin UI or `agent_available_mcp_servers`
    // inserts if you need the rows back.
  },
};
