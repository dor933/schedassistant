"use strict";

/**
 * Adds a second web-search system agent (powered by Brave Search via MCP)
 * and introduces a per-organization pointer to the chosen web-search agent.
 *
 * 1. Seeds the `brave-search` MCP server.
 * 2. Seeds a second system agent (`web_search_brave`, locked, fixed UUID).
 * 3. Links that agent to the brave-search MCP server.
 * 4. Adds `web_search_agent_id` FK column to `organizations`.
 * 5. Backfills every existing organization with the Gemini-powered
 *    web_search agent as the default choice.
 *
 * Only ONE web-search agent can be active per organization — the pointer
 * on `organizations.web_search_agent_id` is what DelegateWebSearchTool
 * resolves at runtime.
 *
 * @type {import('sequelize-cli').Migration}
 */

const WEB_SEARCH_AGENT_ID_GEMINI = "00000000-0000-4000-a000-000000000200";
const WEB_SEARCH_AGENT_ID_BRAVE  = "00000000-0000-4000-a000-000000000201";
const DEFAULT_ORG_ID             = "00000000-0000-4000-d000-000000000001";

const GEMINI_INSTRUCTIONS =
  "You are THE dedicated web-search system agent for this organization. " +
  "All web searches from other agents are routed directly to you. " +
  "Use the built-in Google Search tool (googleSearch toolConfig) to find " +
  "accurate, up-to-date information from the internet. Summarize clearly, " +
  "cite sources when possible, and return the most relevant findings.";

const BRAVE_INSTRUCTIONS =
  "You are THE dedicated web-search system agent for this organization. " +
  "All web searches from other agents are routed directly to you. " +
  "Use the `brave-search` MCP server's tools to run queries against " +
  "Brave Search and fetch pages, then summarize findings clearly, cite " +
  "sources when possible, and return the most relevant results.";

module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Seed the brave-search MCP server.
    await queryInterface.sequelize.query(
      `INSERT INTO mcp_servers (name, transport, command, args, env, created_at, updated_at)
       VALUES (
         'brave-search',
         'stdio',
         'npx',
         :args,
         :env,
         NOW(),
         NOW()
       )
       ON CONFLICT (name) DO NOTHING`,
      {
        replacements: {
          args: JSON.stringify(["-y", "@modelcontextprotocol/server-brave-search"]),
          env: JSON.stringify({ BRAVE_API_KEY: "{{BRAVE_API_KEY}}" }),
        },
      },
    );

    // 2. Resolve a non-Google default model for the Brave agent.
    const [models] = await queryInterface.sequelize.query(
      `SELECT id FROM models WHERE slug = 'claude-sonnet-4-6' LIMIT 1`,
    );
    const braveModelId = models.length > 0 ? models[0].id : null;

    // 3. Seed the Brave-powered web search system agent in the Default org.
    //    Locked from the start; the `instructions` field is what the deep
    //    agent worker feeds into the LLM as the system prompt.
    await queryInterface.sequelize.query(
      `INSERT INTO agents (
         id, type, slug, agent_name, description, instructions,
         model_slug, model_id, tool_config, is_locked, organization_id,
         created_at, updated_at
       ) VALUES (
         CAST(:id AS uuid),
         'system',
         'web_search_brave',
         'Web Search Agent (Brave)',
         'Searches the web using Brave Search (via MCP) to find up-to-date information, articles, documentation, and answers to questions.',
         :instructions,
         'claude-sonnet-4-6',
         CAST(:modelId AS uuid),
         '{"locked": true}'::jsonb,
         true,
         CAST(:orgId AS uuid),
         NOW(),
         NOW()
       )
       ON CONFLICT (id) DO NOTHING`,
      {
        replacements: {
          id: WEB_SEARCH_AGENT_ID_BRAVE,
          modelId: braveModelId,
          orgId: DEFAULT_ORG_ID,
          instructions: BRAVE_INSTRUCTIONS,
        },
      },
    );

    // 4. Also refresh the existing Gemini web_search agent's instructions so
    //    it reads the same "I am THE dedicated web-search agent" framing.
    await queryInterface.sequelize.query(
      `UPDATE agents
         SET instructions = :instructions,
             updated_at = NOW()
       WHERE id = CAST(:id AS uuid) OR slug = 'web_search'`,
      {
        replacements: {
          id: WEB_SEARCH_AGENT_ID_GEMINI,
          instructions: GEMINI_INSTRUCTIONS,
        },
      },
    );

    // 5. Link the Brave agent to the brave-search MCP server (active=true).
    // NOTE: agent_available_mcp_servers has only created_at, no updated_at.
    await queryInterface.sequelize.query(
      `INSERT INTO agent_available_mcp_servers (agent_id, mcp_server_id, active, created_at)
       SELECT CAST(:agentId AS uuid), m.id, true, NOW()
         FROM mcp_servers m
        WHERE m.name = 'brave-search'
       ON CONFLICT DO NOTHING`,
      { replacements: { agentId: WEB_SEARCH_AGENT_ID_BRAVE } },
    );

    // 6. Add the per-organization pointer column.
    await queryInterface.addColumn("organizations", "web_search_agent_id", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "agents", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    });

    // 7. Backfill every existing org with the Gemini agent as the default.
    await queryInterface.sequelize.query(
      `UPDATE organizations
         SET web_search_agent_id = CAST(:geminiId AS uuid),
             updated_at = NOW()
       WHERE web_search_agent_id IS NULL`,
      { replacements: { geminiId: WEB_SEARCH_AGENT_ID_GEMINI } },
    );

    await queryInterface.addIndex("organizations", ["web_search_agent_id"], {
      name: "organizations_web_search_agent_id",
    });
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeIndex(
      "organizations",
      "organizations_web_search_agent_id",
    );
    await queryInterface.removeColumn("organizations", "web_search_agent_id");

    await queryInterface.sequelize.query(
      `DELETE FROM agent_available_mcp_servers
        WHERE agent_id = CAST(:id AS uuid)`,
      { replacements: { id: WEB_SEARCH_AGENT_ID_BRAVE } },
    );
    await queryInterface.sequelize.query(
      `DELETE FROM agents WHERE id = CAST(:id AS uuid)`,
      { replacements: { id: WEB_SEARCH_AGENT_ID_BRAVE } },
    );
    await queryInterface.sequelize.query(
      `DELETE FROM mcp_servers WHERE name = 'brave-search'`,
    );
  },
};
