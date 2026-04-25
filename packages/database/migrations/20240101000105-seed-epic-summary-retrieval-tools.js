"use strict";

/**
 * Seeds the two epic-summary retrieval tools used by the Epic Task
 * Orchestrator to surface past work to users:
 *
 *   - `search_epic_tasks_by_date` — find an epic by creation-date window.
 *   - `get_epic_task_summaries`    — return saved per-task summary file
 *                                    paths for a chosen epic so the
 *                                    orchestrator can fan them out via
 *                                    `send_file_to_user`.
 *
 * NOT auto-assigned (same policy as `send_file_to_user`) — admins grant per
 * agent via `agent_available_tools` since these tools read across all past
 * epics in the org.
 *
 * @type {import('sequelize-cli').Migration}
 */

const TOOLS = [
  {
    name: "Search Epic Tasks by Date",
    slug: "search_epic_tasks_by_date",
    category: "epic_retrieval",
    description:
      "General-purpose lookup of past epic tasks by creation-date window. Returns id, title, status, " +
      "timestamps, task count, and the full description per match. Use to find an epic to fetch " +
      "summaries for, to reuse an old epic's scope in a new create_epic_plan, or to answer scope " +
      "questions directly.",
  },
  {
    name: "Get Epic Task Summaries",
    slug: "get_epic_task_summaries",
    category: "epic_retrieval",
    description:
      "Returns the saved per-task summary file paths for a given epic. Use after identifying the epic " +
      "via search_epic_tasks_by_date — pass each path to send_file_to_user to deliver as chat attachments.",
  },
];

module.exports = {
  async up(queryInterface, _Sequelize) {
    for (const t of TOOLS) {
      await queryInterface.sequelize.query(
        `INSERT INTO tools (name, slug, description, category, created_at, updated_at)
         VALUES (:name, :slug, :description, :category, NOW(), NOW())
         ON CONFLICT (slug) DO NOTHING`,
        { replacements: t },
      );
    }
  },

  async down(queryInterface, _Sequelize) {
    const slugs = TOOLS.map((t) => t.slug);
    await queryInterface.sequelize.query(
      `DELETE FROM agent_available_tools
        WHERE tool_id IN (SELECT id FROM tools WHERE slug IN (:slugs))`,
      { replacements: { slugs } },
    );
    await queryInterface.sequelize.query(
      `DELETE FROM tools WHERE slug IN (:slugs)`,
      { replacements: { slugs } },
    );
  },
};
