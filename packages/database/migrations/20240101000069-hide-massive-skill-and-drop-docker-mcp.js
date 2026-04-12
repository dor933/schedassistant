"use strict";

/** @type {import('sequelize-cli').Migration}
 *
 * Three cleanups:
 *
 * 1. Add `primary_agent_assignable` and `system_agent_assignable` boolean
 *    columns to `mcp_servers`, mirroring the same flags on `skills`.
 *    Default both to `true`, then flip `primary_agent_assignable = false`
 *    on `massive_market_data` (reserved for system agents only).
 *
 * 2. Hide the `mcp-massive-market-data` *skill* from primary agents too
 *    (belt-and-suspenders — the MCP gate + the skill gate both block it).
 *
 * 3. Remove the `docker` MCP server entirely (docker access goes through
 *    the bash MCP skill instead).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1a. Add assignability columns to mcp_servers.
    await queryInterface.addColumn("mcp_servers", "primary_agent_assignable", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });
    await queryInterface.addColumn("mcp_servers", "system_agent_assignable", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });

    // 1b. massive_market_data → system agents only, not primary.
    await queryInterface.sequelize.query(
      `UPDATE mcp_servers
         SET primary_agent_assignable = false,
             updated_at = NOW()
       WHERE name = 'massive_market_data'`,
    );

    // 2. Hide massive skill from primary agents.
    await queryInterface.sequelize.query(
      `UPDATE skills
         SET primary_agent_assignable = false,
             updated_at = NOW()
       WHERE slug = 'mcp-massive-market-data'`,
    );

    // 3. Drop docker MCP server + any join-table references.
    await queryInterface.sequelize.query(
      `DELETE FROM agents_mcp_servers
        WHERE mcp_server_id IN (SELECT id FROM mcp_servers WHERE name = 'docker')`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM system_agents_mcp_servers
        WHERE mcp_server_id IN (SELECT id FROM mcp_servers WHERE name = 'docker')`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM mcp_servers WHERE name = 'docker'`,
    );
  },

  async down(queryInterface) {
    // Restore primary-agent assignability for the massive skill.
    await queryInterface.sequelize.query(
      `UPDATE skills
         SET primary_agent_assignable = true,
             updated_at = NOW()
       WHERE slug = 'mcp-massive-market-data'`,
    );

    // Re-seed the docker MCP server row (same shape as migration 0030).
    await queryInterface.bulkInsert("mcp_servers", [
      {
        name: "docker",
        transport: "stdio",
        command: "npx",
        args: JSON.stringify(["-y", "@alisaitteke/docker-mcp"]),
        env: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);

    // Remove assignability columns.
    await queryInterface.removeColumn("mcp_servers", "system_agent_assignable");
    await queryInterface.removeColumn("mcp_servers", "primary_agent_assignable");
  },
};
