"use strict";

/**
 * Adds a second web-search system agent (powered by Tavily via the native
 * @langchain/tavily LangChain tool) and introduces a per-organization
 * pointer to the chosen web-search agent.
 *
 * 1. Seeds a second system agent (`web_search_tavily`, locked, fixed UUID)
 *    with tool_config `{ useTavily: true, locked: true }` — the deep agent
 *    worker reads `useTavily` and injects the Tavily tool at runtime.
 * 2. Refreshes the existing Gemini `web_search` agent's instructions so
 *    both agents use the same "I am THE dedicated web-search agent" framing.
 * 3. Adds `web_search_agent_id` FK column to `organizations`.
 * 4. Backfills every existing organization with the Gemini-powered
 *    `web_search` agent as the default choice.
 *
 * Only ONE web-search agent can be active per organization — the pointer
 * on `organizations.web_search_agent_id` is what `DelegateWebSearchTool`
 * resolves at runtime. Tavily requires `TAVILY_API_KEY` in the agent_service
 * environment; unlike the Brave variant this replaces, there is NO MCP
 * subprocess involved.
 *
 * @type {import('sequelize-cli').Migration}
 */

const WEB_SEARCH_AGENT_ID_GEMINI = "00000000-0000-4000-a000-000000000200";
const WEB_SEARCH_AGENT_ID_TAVILY = "00000000-0000-4000-a000-000000000201";
const DEFAULT_ORG_ID             = "00000000-0000-4000-d000-000000000001";

const GEMINI_INSTRUCTIONS =
  "You are THE dedicated web-search system agent for this organization. " +
  "All web searches from other agents are routed directly to you. " +
  "Use the built-in Google Search tool (googleSearch toolConfig) to find " +
  "accurate, up-to-date information from the internet. Summarize clearly, " +
  "cite sources when possible, and return the most relevant findings.";

const TAVILY_INSTRUCTIONS =
  "You are THE dedicated web-search system agent for this organization. " +
  "All web searches from other agents are routed directly to you. " +
  "Use the `tavily_search` tool to run queries against Tavily and fetch " +
  "results, then summarize findings clearly, cite sources when possible, " +
  "and return the most relevant results.";

module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Resolve a non-Google default model for the Tavily agent.
    const [models] = await queryInterface.sequelize.query(
      `SELECT id FROM models WHERE slug = 'claude-sonnet-4-6' LIMIT 1`,
    );
    const tavilyModelId = models.length > 0 ? models[0].id : null;

    // 2. Seed the Tavily-powered web search system agent in the Default org.
    //    Locked from the start; `instructions` is the system prompt the deep
    //    agent worker feeds into the LLM. `useTavily: true` in tool_config
    //    tells the worker to inject the Tavily LangChain tool at runtime.
    await queryInterface.sequelize.query(
      `INSERT INTO agents (
         id, type, slug, agent_name, description, instructions,
         model_slug, model_id, tool_config, is_locked, organization_id,
         created_at, updated_at
       ) VALUES (
         CAST(:id AS uuid),
         'system',
         'web_search_tavily',
         'Web Search Agent (Tavily)',
         'Searches the web using Tavily to find up-to-date information, articles, documentation, and answers to questions.',
         :instructions,
         'claude-sonnet-4-6',
         CAST(:modelId AS uuid),
         '{"useTavily": true, "locked": true}'::jsonb,
         true,
         CAST(:orgId AS uuid),
         NOW(),
         NOW()
       )
       ON CONFLICT (id) DO NOTHING`,
      {
        replacements: {
          id: WEB_SEARCH_AGENT_ID_TAVILY,
          modelId: tavilyModelId,
          orgId: DEFAULT_ORG_ID,
          instructions: TAVILY_INSTRUCTIONS,
        },
      },
    );

    // 3. Refresh the existing Gemini web_search agent's instructions so
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

    // 4. Add the per-organization pointer column.
    await queryInterface.addColumn("organizations", "web_search_agent_id", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "agents", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    });

    // 5. Backfill every existing org with the Gemini agent as the default.
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
      `DELETE FROM agents WHERE id = CAST(:id AS uuid)`,
      { replacements: { id: WEB_SEARCH_AGENT_ID_TAVILY } },
    );
  },
};
