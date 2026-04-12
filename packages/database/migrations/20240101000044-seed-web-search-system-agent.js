"use strict";

const WEB_SEARCH_AGENT_ID = "00000000-0000-4000-a000-000000000200";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `INSERT INTO agents (id, type, slug, agent_name, description, instructions, model_slug, tool_config, created_at, updated_at)
       VALUES (
         CAST(:id AS uuid),
         'system',
         'web_search',
         'Web Search Agent',
         'Searches the web using Google Search to find up-to-date information, articles, documentation, and answers to questions.',
         'You are a web search specialist. Use Google Search to find accurate, up-to-date information from the internet. Summarize your findings clearly, cite sources when possible, and highlight the most relevant results for the task at hand.',
         'gemini-3.1-pro-preview',
         '{"googleSearch": true, "locked": true}',
         NOW(),
         NOW()
       )
       ON CONFLICT (id) DO NOTHING`,
      { replacements: { id: WEB_SEARCH_AGENT_ID } },
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `DELETE FROM agents WHERE id = :id`,
      { replacements: { id: WEB_SEARCH_AGENT_ID } },
    );
  },
};
