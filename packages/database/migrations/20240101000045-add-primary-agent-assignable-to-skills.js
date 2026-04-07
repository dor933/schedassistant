"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Add the new column (default true so existing custom skills stay assignable)
    await queryInterface.addColumn("skills", "primary_agent_assignable", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });

    // 2. MCP-based skills → system agents only (not primary)
    await queryInterface.sequelize.query(
      `UPDATE skills
         SET primary_agent_assignable = false,
             updated_at = NOW()
       WHERE slug IN ('mcp-git-cli-bash', 'mcp-github-api', 'mcp-filesystem-repo', 'mcp-bash-build-test')`,
    );

    // 3. Also mark those MCP skills as system-agent-assignable (some were already,
    //    but mcp-filesystem-repo was set to false by migration 0042 — correct that)
    await queryInterface.sequelize.query(
      `UPDATE skills
         SET system_agent_assignable = true,
             updated_at = NOW()
       WHERE slug IN ('mcp-git-cli-bash', 'mcp-github-api', 'mcp-filesystem-repo', 'mcp-bash-build-test')`,
    );

    // 4. dev-in-house-* skills → primary agents only (not system)
    //    They were already system_agent_assignable = false from the seed,
    //    but make sure primary_agent_assignable = true (the default).
    //    No UPDATE needed — default true is correct.
  },

  async down(queryInterface) {
    // Revert mcp-filesystem-repo back to system_agent_assignable = false
    await queryInterface.sequelize.query(
      `UPDATE skills
         SET system_agent_assignable = false,
             updated_at = NOW()
       WHERE slug = 'mcp-filesystem-repo'`,
    );

    await queryInterface.removeColumn("skills", "primary_agent_assignable");
  },
};
