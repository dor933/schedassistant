"use strict";

/**
 * Originally: linked the `gh-cli` skill to the global Epic Orchestrator
 * (migration 0059's agent row) AND updated the `epic-task-workflow` skill's
 * body to reflect auto-created PRs. The global Epic Orchestrator was removed
 * — each org provisions its own via `orgAgentSeeder.ts`, which already links
 * `gh-cli` — so the agent-specific INSERT/DELETE here would either FK-fail
 * or target a row that no longer exists.
 *
 * The skill-text UPDATE, however, still matters: the `epic-task-workflow`
 * skill is a global row that all per-org Epic Orchestrators reference.
 * Keep only that UPDATE so the skill body is corrected on fresh installs
 * too (the skill is seeded earlier in the migration chain by 0049-ish —
 * REPLACE on a string that isn't present is a no-op, so this is safe even
 * if the skill text has since been further edited).
 *
 * @type {import('sequelize-cli').Migration}
 */

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
      `UPDATE skills
       SET skill_text = REPLACE(skill_text, :newSection, :oldSection),
           updated_at = :now
       WHERE slug = 'epic-task-workflow'`,
      { replacements: { oldSection: OLD_PR_SECTION, newSection: NEW_PR_SECTION, now } },
    );
  },
};
