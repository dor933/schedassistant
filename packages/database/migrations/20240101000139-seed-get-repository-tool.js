"use strict";

/**
 * Seeds the new `get_repository` tool and grants it to every primary agent
 * that already has `list_repositories`. Companion to `list_repositories`,
 * which now returns only an ID index — agents need `get_repository` to fetch
 * the heavy fields (URL, local path, architecture overview, setup instructions)
 * for a single repo at a time.
 */

const TOOL = {
  name: "Get Repository",
  slug: "get_repository",
  category: "data",
  description: "Fetch the full record for a single repository by ID (URL, local path, architecture overview, setup instructions).",
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `INSERT INTO tools (name, slug, description, category, created_at, updated_at)
       VALUES (:name, :slug, :description, :category, NOW(), NOW())
       ON CONFLICT (slug) DO NOTHING`,
      { replacements: TOOL },
    );

    // Grant `get_repository` to every agent that already has `list_repositories`
    // — the two tools are paired and an agent that can list repos should also
    // be able to fetch them.
    await queryInterface.sequelize.query(
      `INSERT INTO agent_available_tools (agent_id, tool_id, active, created_at)
       SELECT aat.agent_id, get_tool.id, true, NOW()
       FROM agent_available_tools aat
       JOIN tools list_tool ON list_tool.id = aat.tool_id AND list_tool.slug = 'list_repositories'
       CROSS JOIN tools get_tool
       WHERE get_tool.slug = 'get_repository'
       ON CONFLICT (agent_id, tool_id) DO NOTHING`,
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `DELETE FROM agent_available_tools
       WHERE tool_id IN (SELECT id FROM tools WHERE slug = 'get_repository')`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM tools WHERE slug = 'get_repository'`,
    );
  },
};
