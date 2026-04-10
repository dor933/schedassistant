"use strict";

/**
 * Assigns MCP skills and MCP servers to the Epic Orchestrator agent.
 *
 * Skills: mcp-bash-build-test, mcp-filesystem-repo
 * MCP Servers: bash, filesystem
 *
 * These are linked via the regular agent junction tables (agents_skills,
 * agents_mcp_servers) so the Epic graph's callModel can load them.
 *
 * All operations are idempotent (safe to re-run).
 *
 * @type {import('sequelize-cli').Migration}
 */

const AGENT_ID = "00000000-0000-4000-a000-000000000100";

const MCP_SKILL_SLUGS = [
  "mcp-bash-build-test",
  "mcp-filesystem-repo",
];

const MCP_SERVER_NAMES = ["bash", "filesystem"];

module.exports = {
  async up(queryInterface) {
    const now = new Date();

    // 1. Link MCP skills to the Epic Orchestrator (agents_skills)
    for (const slug of MCP_SKILL_SLUGS) {
      await queryInterface.sequelize.query(
        `INSERT INTO agents_skills (agent_id, skill_id, created_at)
         SELECT :agentId, s.id, :now
         FROM skills s
         WHERE s.slug = :slug
           AND NOT EXISTS (
             SELECT 1 FROM agents_skills
             WHERE agent_id = :agentId AND skill_id = s.id
           )`,
        {
          replacements: { agentId: AGENT_ID, slug, now },
        },
      );
    }

    // 2. Link MCP servers to the Epic Orchestrator (agents_mcp_servers)
    for (const name of MCP_SERVER_NAMES) {
      await queryInterface.sequelize.query(
        `INSERT INTO agents_mcp_servers (agent_id, mcp_server_id, created_at)
         SELECT :agentId, ms.id, :now
         FROM mcp_servers ms
         WHERE ms.name = :name
           AND NOT EXISTS (
             SELECT 1 FROM agents_mcp_servers
             WHERE agent_id = :agentId AND mcp_server_id = ms.id
           )`,
        {
          replacements: { agentId: AGENT_ID, name, now },
        },
      );
    }
  },

  async down(queryInterface) {
    // Remove MCP server links
    for (const name of MCP_SERVER_NAMES) {
      await queryInterface.sequelize.query(
        `DELETE FROM agents_mcp_servers
         WHERE agent_id = :agentId
           AND mcp_server_id IN (SELECT id FROM mcp_servers WHERE name = :name)`,
        { replacements: { agentId: AGENT_ID, name } },
      ).catch(() => {});
    }

    // Remove MCP skill links
    for (const slug of MCP_SKILL_SLUGS) {
      await queryInterface.sequelize.query(
        `DELETE FROM agents_skills
         WHERE agent_id = :agentId
           AND skill_id IN (SELECT id FROM skills WHERE slug = :slug)`,
        { replacements: { agentId: AGENT_ID, slug } },
      ).catch(() => {});
    }
  },
};
