"use strict";

/** @type {import('sequelize-cli').Migration}
 *
 * Remove the "Ongoing requests" skill (`dev-in-house-ongoing-requests`).
 */
module.exports = {
  async up(queryInterface) {
    // Remove any agent ↔ skill links first (FK constraint).
    await queryInterface.sequelize.query(
      `DELETE FROM agent_available_skills
        WHERE skill_id IN (SELECT id FROM skills WHERE slug = 'dev-in-house-ongoing-requests')`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM skills WHERE slug = 'dev-in-house-ongoing-requests'`,
    );
  },

  async down(queryInterface) {
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
        locked: false,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
  },
};
