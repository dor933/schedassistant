"use strict";

/** @type {import('sequelize-cli').Migration}
 *
 * Remove the "Ongoing requests" skill (`dev-in-house-ongoing-requests`).
 * It was seeded in migration 0040 but never received a backing tool
 * implementation — the `add_ongoing_request` / `remove_ongoing_request`
 * tools it describes do not exist. Clean up the dead row and any
 * join-table references.
 */
module.exports = {
  async up(queryInterface) {
    // Remove any agent ↔ skill links first (FK constraint).
    await queryInterface.sequelize.query(
      `DELETE FROM agents_skills
        WHERE skill_id IN (SELECT id FROM skills WHERE slug = 'dev-in-house-ongoing-requests')`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM system_agents_skills
        WHERE skill_id IN (SELECT id FROM skills WHERE slug = 'dev-in-house-ongoing-requests')`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM skills WHERE slug = 'dev-in-house-ongoing-requests'`,
    );
  },

  async down(queryInterface) {
    // Re-seed the skill (matches original shape from migration 0040).
    await queryInterface.bulkInsert("skills", [
      {
        slug: "dev-in-house-ongoing-requests",
        name: "Ongoing requests",
        description: "add_ongoing_request / remove_ongoing_request.",
        skill_text: `# Ongoing requests

- **\`add_ongoing_request\`** — track multi-turn follow-ups (shown in system prompt).
- **\`remove_ongoing_request\`** — use \`request_id\` from the prompt when done.

## Related
- Agent notes → \`dev-in-house-agent-notes\`.`,
        system_agent_assignable: false,
        primary_agent_assignable: true,
        locked: false,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
  },
};
