"use strict";

/**
 * Seeds the `tools` table with all code-defined configurable tools and assigns
 * them (active) to every existing primary agent so nothing breaks.
 *
 * Tools categorized as "core" (notes, memory, workspace, skills, identity)
 * stay hardcoded — they are always available to every agent and are not
 * managed through this table.
 */

const TOOLS = [
  { name: "Consult Agent", slug: "consult_agent", category: "delegation", description: "Ask a peer agent a question and get an answer within the same turn." },
  { name: "List Agents", slug: "list_agents", category: "delegation", description: "List all peer agents available for consultation." },
  { name: "List System Agents", slug: "list_system_agents", category: "delegation", description: "List executor/specialist system agents available for delegation." },
  { name: "Delegate to Deep Agent", slug: "delegate_to_deep_agent", category: "delegation", description: "Delegate a task to a system agent for asynchronous execution." },
  { name: "Delegate to Epic Orchestrator", slug: "delegate_to_epic_orchestrator", category: "delegation", description: "Delegate multi-step code tasks to the Epic Orchestrator agent." },
  { name: "List Projects", slug: "list_projects", category: "data", description: "List all projects (name, ID, tech stack)." },
  { name: "List Repositories", slug: "list_repositories", category: "data", description: "List repositories within a project." },
  { name: "Query Database", slug: "query_database", category: "data", description: "Run read-only SQL queries against the external analytics database." },
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, _Sequelize) {
    // 1. Seed tools
    for (const t of TOOLS) {
      await queryInterface.sequelize.query(
        `INSERT INTO tools (name, slug, description, category, created_at, updated_at)
         VALUES (:name, :slug, :description, :category, NOW(), NOW())
         ON CONFLICT (slug) DO NOTHING`,
        { replacements: t },
      );
    }

    // 2. Assign all tools to every existing primary agent
    const [agents] = await queryInterface.sequelize.query(
      `SELECT id FROM agents WHERE type = 'primary'`,
    );
    const [tools] = await queryInterface.sequelize.query(
      `SELECT id FROM tools`,
    );

    for (const agent of agents) {
      for (const tool of tools) {
        await queryInterface.sequelize.query(
          `INSERT INTO agent_available_tools (agent_id, tool_id, active, created_at)
           VALUES (:agentId, :toolId, true, NOW())
           ON CONFLICT (agent_id, tool_id) DO NOTHING`,
          { replacements: { agentId: agent.id, toolId: tool.id } },
        );
      }
    }
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(`DELETE FROM agent_available_tools`);
    const slugs = TOOLS.map((t) => t.slug);
    await queryInterface.sequelize.query(
      `DELETE FROM tools WHERE slug IN (:slugs)`,
      { replacements: { slugs } },
    );
  },
};
