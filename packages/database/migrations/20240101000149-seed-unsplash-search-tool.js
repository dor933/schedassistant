"use strict";

/**
 * Seeds the native Unsplash photo search tool.
 *
 * The tool returns hotlinked Unsplash image URLs plus attribution fields, so it
 * is safe to expose as a normal media/data lookup capability. Existing primary
 * agents receive it active by default; admins can toggle it per agent through
 * the normal agent_available_tools surface.
 */

const TOOL = {
  name: "Unsplash Photo Search",
  slug: "unsplash_search_photos",
  category: "media",
  description:
    "Search Unsplash photos by query and return hotlinked image URLs, photographer credits, attribution HTML/Markdown, and download tracking metadata.",
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

    await queryInterface.sequelize.query(
      `INSERT INTO agent_available_tools (agent_id, tool_id, active, created_at)
       SELECT agents.id, tools.id, true, NOW()
       FROM agents
       CROSS JOIN tools
       WHERE agents.type = 'primary'
         AND tools.slug = :slug
       ON CONFLICT (agent_id, tool_id) DO NOTHING`,
      { replacements: { slug: TOOL.slug } },
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `DELETE FROM agent_available_tools
       WHERE tool_id IN (SELECT id FROM tools WHERE slug = :slug)`,
      { replacements: { slug: TOOL.slug } },
    );
    await queryInterface.sequelize.query(
      `DELETE FROM tools WHERE slug = :slug`,
      { replacements: { slug: TOOL.slug } },
    );
  },
};
