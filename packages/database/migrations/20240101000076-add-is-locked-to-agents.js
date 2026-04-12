"use strict";

/**
 * 1. Adds an `is_locked` boolean column to `agents`. Locked agents cannot be
 *    edited from the admin UI (definition, instructions, model, MCP servers, skills).
 * 2. Locks the seeded `web_search` system agent, strips any MCP server / skill
 *    assignments it may have, and pins it to `gemini-3.1-pro-preview`.
 *
 * @type {import('sequelize-cli').Migration}
 */

const WEB_SEARCH_AGENT_ID = "00000000-0000-4000-a000-000000000200";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("agents", "is_locked", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    await queryInterface.sequelize.query(
      `UPDATE agents
         SET is_locked = true,
             model_slug = 'gemini-3.1-pro-preview',
             model_id = NULL,
             updated_at = NOW()
       WHERE id = CAST(:id AS uuid) OR slug = 'web_search'`,
      { replacements: { id: WEB_SEARCH_AGENT_ID } },
    );

    await queryInterface.sequelize.query(
      `DELETE FROM agent_available_mcp_servers
        WHERE agent_id IN (
          SELECT id FROM agents WHERE id = CAST(:id AS uuid) OR slug = 'web_search'
        )`,
      { replacements: { id: WEB_SEARCH_AGENT_ID } },
    );

    await queryInterface.sequelize.query(
      `DELETE FROM agent_available_skills
        WHERE agent_id IN (
          SELECT id FROM agents WHERE id = CAST(:id AS uuid) OR slug = 'web_search'
        )`,
      { replacements: { id: WEB_SEARCH_AGENT_ID } },
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeColumn("agents", "is_locked");
  },
};
