"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `INSERT INTO system_agents (slug, name, description, instructions, model_slug, tool_config, created_at, updated_at)
       VALUES (
         'web_search',
         'Web Search Agent',
         'Searches the web using Google Search to find up-to-date information, articles, documentation, and answers to questions.',
         'You are a web search specialist. Use Google Search to find accurate, up-to-date information from the internet. Summarize your findings clearly, cite sources when possible, and highlight the most relevant results for the task at hand.',
         'gemini-3.1-pro-preview',
         '{"googleSearch": true, "locked": true}',
         NOW(),
         NOW()
       )
       ON CONFLICT (slug) DO NOTHING`,
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `DELETE FROM system_agents WHERE slug = 'web_search'`,
    );
  },
};
