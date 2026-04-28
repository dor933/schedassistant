"use strict";

/**
 * Seeds the `invoke_application_agent` tool. Intentionally NOT auto-assigned
 * to every primary agent — admins grant it per-agent via agent_available_tools.
 *
 * When a primary has this slug active, the basic-graph context builder also
 * injects an "Available application agents" section listing every
 * type='application' agent in the org, so the primary knows what each one is
 * for and can pass the right UUID into the tool.
 */

const TOOL = {
  name: "Invoke Application Agent",
  slug: "invoke_application_agent",
  category: "agents",
  description:
    "Synchronously invoke an application agent (REST-style stateless specialist) " +
    "and return its final answer inline. Application agents are listed in the " +
    "primary's system prompt with their UUID and goal.",
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
