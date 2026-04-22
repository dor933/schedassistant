"use strict";

/**
 * Seeds the `send_file_to_user` tool. Intentionally NOT auto-assigned to
 * every agent (unlike 20240101000079-seed-tools-and-assign-to-agents.js) —
 * admins grant it per-agent via agent_available_tools. The tool hands a file
 * from the agent's workspace to the user as a downloadable attachment, so it
 * is treated as a privileged capability.
 */

const TOOL = {
  name: "Send File to User",
  slug: "send_file_to_user",
  category: "files",
  description:
    "Hands a file from the agent's workspace to the user as a downloadable attachment in the chat.",
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
