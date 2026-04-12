"use strict";

/**
 * Assigns gh-cli skill to the Epic Orchestrator and updates epic-task-workflow.
 *
 * @type {import('sequelize-cli').Migration}
 */

const AGENT_ID = "00000000-0000-4000-a000-000000000100";

const OLD_PR_SECTION = `### Between stages — Creating the Pull Request
- After all tasks in a stage complete, **you must create a PR** for that stage.
- Use the \`run_command\` tool (from the **Git CLI / bash MCP** skill) to run git and GitHub CLI commands directly:
  1. Push the branch: \`git -C <localPath> push origin <branch>\`
  2. Create the PR: \`gh pr create --repo OWNER/REPO --head <branch> --base main --title "..." --body "..."\`
- Then call \`update_stage_pr\` with the PR URL to link it to the stage.
- The next stage's tasks are **blocked** until the PR is approved (via the \`pr-approved\` webhook).
- Use \`get_epic_status\` to check progress and see which tasks are blocked.
- Inform the user when tasks are waiting for PR approval.`;

const NEW_PR_SECTION = `### Between stages — Pull Request (created automatically)
- After all tasks in a stage complete, a PR is **created automatically** by the system — you do NOT need to create it.
- The system pushes the branch, runs \`gh pr create\`, and updates the stage record.
- If auto-creation fails, you will see an error in the tool result with manual instructions.
- The next stage's tasks are **blocked** until the PR is approved (via the \`pr-approved\` webhook).
- Use \`get_epic_status\` to check progress and see which tasks are blocked.
- **Report to the user** that the PR has been created and that the next stage is waiting for approval.`;

module.exports = {
  async up(queryInterface) {
    const now = new Date();

    // 1. Add the consolidated gh-cli skill
    await queryInterface.sequelize.query(
      `INSERT INTO agent_available_skills (agent_id, skill_id, active, created_at)
       SELECT :agentId, s.id, true, :now
       FROM skills s
       WHERE s.slug = 'gh-cli'
         AND NOT EXISTS (
           SELECT 1 FROM agent_available_skills
           WHERE agent_id = :agentId AND skill_id = s.id
         )`,
      { replacements: { agentId: AGENT_ID, now } },
    );

    // 2. Remove the old mcp-git-cli-bash skill (superseded by gh-cli)
    await queryInterface.sequelize.query(
      `DELETE FROM agent_available_skills
       WHERE agent_id = :agentId
         AND skill_id IN (SELECT id FROM skills WHERE slug = 'mcp-git-cli-bash')`,
      { replacements: { agentId: AGENT_ID } },
    ).catch(() => {});

    // 3. Update the epic-task-workflow skill text — PR is now auto-created
    await queryInterface.sequelize.query(
      `UPDATE skills
       SET skill_text = REPLACE(skill_text, :oldSection, :newSection),
           updated_at = :now
       WHERE slug = 'epic-task-workflow'`,
      { replacements: { oldSection: OLD_PR_SECTION, newSection: NEW_PR_SECTION, now } },
    );
  },

  async down(queryInterface) {
    const now = new Date();

    await queryInterface.sequelize.query(
      `DELETE FROM agent_available_skills
       WHERE agent_id = :agentId
         AND skill_id IN (SELECT id FROM skills WHERE slug = 'gh-cli')`,
      { replacements: { agentId: AGENT_ID } },
    ).catch(() => {});

    await queryInterface.sequelize.query(
      `INSERT INTO agent_available_skills (agent_id, skill_id, active, created_at)
       SELECT :agentId, s.id, true, :now
       FROM skills s
       WHERE s.slug = 'mcp-git-cli-bash'
         AND NOT EXISTS (
           SELECT 1 FROM agent_available_skills
           WHERE agent_id = :agentId AND skill_id = s.id
         )`,
      { replacements: { agentId: AGENT_ID, now } },
    );

    await queryInterface.sequelize.query(
      `UPDATE skills
       SET skill_text = REPLACE(skill_text, :newSection, :oldSection),
           updated_at = :now
       WHERE slug = 'epic-task-workflow'`,
      { replacements: { oldSection: OLD_PR_SECTION, newSection: NEW_PR_SECTION, now } },
    );
  },
};
