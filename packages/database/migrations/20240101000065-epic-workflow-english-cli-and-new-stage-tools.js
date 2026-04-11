"use strict";

/**
 * Updates the `epic-task-workflow` skill text with:
 *
 * 1. A rule requiring **every field** stored on epic_tasks / task_stages /
 *    agent_tasks / task_executions (titles, descriptions, feedback, metadata,
 *    and the CLI prompt itself) to be written in English, regardless of the
 *    language the user is using in chat. The user may speak Hebrew or any
 *    other language — the agent translates to English before writing anything
 *    into these tables, so that every value the Claude CLI sees is English.
 * 2. Documentation for the new stage lifecycle tools:
 *    - `approve_stage`          — manually approve a stage from chat
 *    - `request_stage_changes`  — request changes on a pr_pending stage from chat
 * 3. Updated "Between stages" section reflecting the new `pr_pending` status
 *    and the two approval paths (webhook vs. chat).
 *
 * @type {import('sequelize-cli').Migration}
 */

// ─── 1. English-only rule for CLI prompts ──────────────────────────────────

const OLD_TASK_DESC_INSTRUCTION = `- Write the task \`description\` as a **detailed prompt** for the Claude CLI executor — specify:
  - Which files to create or modify
  - What logic to implement
  - Constraints, edge cases, naming conventions
  - Any context the executor needs (it cannot ask follow-up questions)`;

const NEW_TASK_DESC_INSTRUCTION = `- Write the task \`description\` as a **detailed prompt** for the Claude CLI executor — specify:
  - Which files to create or modify
  - What logic to implement
  - Constraints, edge cases, naming conventions
  - Any context the executor needs (it cannot ask follow-up questions)
- **CRITICAL — English-only for every stored field.** Every value you write into an epic-related table **must** be in English — not only the CLI prompt. This applies to:
  - \`epic_tasks.title\` and \`epic_tasks.description\`
  - \`task_stages.title\` and \`task_stages.description\`
  - \`agent_tasks.title\` and \`agent_tasks.description\`
  - Retry feedback passed to \`request_stage_changes\` and to \`execute_epic_task\` (\`feedback\` argument)
  - PR titles, PR bodies, commit messages, and any metadata you attach
  If the user is speaking Hebrew, Arabic, or any other language, **translate their intent into clear English first**, then write the English version into \`create_epic_plan\`, \`execute_epic_task\`, \`request_stage_changes\`, etc. The Claude CLI executor only ever sees English — it never sees the user's original language. You may still reply to the user in their own language in chat, but nothing in their language ever reaches the epic tables.`;

// ─── 2. Update "Between stages" section for pr_pending flow ────────────────

const OLD_BETWEEN_STAGES = `### Between stages — Pull Request (created automatically)
- After all tasks in a stage complete, a PR is **created automatically** by the system — you do NOT need to create it.
- The system pushes the branch, runs \`gh pr create\`, and updates the stage record.
- If auto-creation fails, you will see an error in the tool result with manual instructions.
- The next stage's tasks are **blocked** until the PR is approved (via the \`pr-approved\` webhook).
- Use \`get_epic_status\` to check progress and see which tasks are blocked.
- **Report to the user** that the PR has been created and that the next stage is waiting for approval.`;

const NEW_BETWEEN_STAGES = `### Between stages — Pull Request & Approval

When all tasks in a stage complete, the stage enters **\`pr_pending\`** status (not \`completed\`). A stage only becomes \`completed\` after explicit approval.

**Automatic PR creation:**
- After all tasks finish, a PR is **created automatically** — you do NOT need to create it.
- The system pushes the branch, runs \`gh pr create\`, and updates the stage record.
- If auto-creation fails, you will see an error with manual instructions.

**Approval (two paths — either one works):**
1. **Webhook (automatic):** The user approves the PR on GitHub → the \`pr-approved\` webhook fires → stage becomes \`completed\` → next stage tasks are unblocked automatically.
2. **Chat (manual):** The user says "approve it" or "looks good" in the conversation → call \`approve_stage\` with the stage ID and a verbatim quote of their approval → same effect.

**Requesting changes from chat:**
- If the user reviews the PR/diff and wants fixes, call \`request_stage_changes\` with the stage ID and their feedback.
- This resets the stage from \`pr_pending\` back to \`in_progress\`, resets completed tasks to \`ready\`, and stores the feedback.
- Then retry each task using \`execute_epic_task\` with \`mode="retry"\` — the previous CLI session is resumed automatically.
- After fixes, the stage returns to \`pr_pending\` and fixes are pushed to the existing PR.

**Important:** The next stage is **blocked** until the current stage's PR is approved. Use \`get_epic_status\` to check which stages are waiting. Report to the user that the PR has been created and is waiting for their review.`;

// ─── 3. Add new tools to the tool reference table ──────────────────────────

const OLD_TOOL_ROW_UPDATE_STAGE = `| \`update_stage_pr\` | Fallback: manually link a PR URL to a stage (auto-creation normally handles this) |`;

const NEW_TOOL_ROW_UPDATE_STAGE = `| \`approve_stage\` | Mark a \`pr_pending\` stage as completed after the user approves it in chat. Requires verbatim user quote. |
| \`request_stage_changes\` | Reset a \`pr_pending\` stage back to \`in_progress\` with feedback so tasks can be retried. Use when the user wants fixes. |
| \`update_stage_pr\` | Fallback: manually link a PR URL to a stage (auto-creation normally handles this) |`;

// ─── 4. Add English rule to the Rules section ─────────────────────────────

const OLD_LAST_RULES = `8. **Use review_task_diff** when the execution report diff is truncated or you need to compare against the base branch before approving.
9. **NEVER call \`force_approve_stage_pr\` on your own initiative.** See the tool reference below for the strict usage rule.`;

const NEW_LAST_RULES = `8. **Use review_task_diff** when the execution report diff is truncated or you need to compare against the base branch before approving.
9. **NEVER call \`force_approve_stage_pr\` on your own initiative.** See the tool reference below for the strict usage rule.
10. **English-only for every field you store on an epic.** This is not limited to the CLI prompt — **every** column you write on \`epic_tasks\`, \`task_stages\`, \`agent_tasks\`, and \`task_executions\` (titles, descriptions, retry feedback, PR titles and bodies, commit messages, metadata) must be in English. If the user is speaking Hebrew, Arabic, or any other language, translate their intent into clear English **before** you pass it to \`create_epic_plan\`, \`execute_epic_task\`, \`request_stage_changes\`, or any other epic tool. The Claude CLI executor and every downstream artifact (PRs, diffs, review comments) should only ever see English. You may — and should — continue to reply to the user in their own language in chat, but nothing in the user's language is allowed to land in the epic tables. Treat any non-English text in these fields as a bug.`;

module.exports = {
  async up(queryInterface) {
    const now = new Date();

    // 1. Add English-only instruction to task description guidelines
    await queryInterface.sequelize.query(
      `UPDATE skills
         SET skill_text = REPLACE(skill_text, :oldText, :newText),
             updated_at = :now
       WHERE slug = 'epic-task-workflow'`,
      {
        replacements: {
          oldText: OLD_TASK_DESC_INSTRUCTION,
          newText: NEW_TASK_DESC_INSTRUCTION,
          now,
        },
      },
    );

    // 2. Update "Between stages" section for pr_pending flow
    await queryInterface.sequelize.query(
      `UPDATE skills
         SET skill_text = REPLACE(skill_text, :oldText, :newText),
             updated_at = :now
       WHERE slug = 'epic-task-workflow'`,
      {
        replacements: {
          oldText: OLD_BETWEEN_STAGES,
          newText: NEW_BETWEEN_STAGES,
          now,
        },
      },
    );

    // 3. Add approve_stage and request_stage_changes to tool table
    await queryInterface.sequelize.query(
      `UPDATE skills
         SET skill_text = REPLACE(skill_text, :oldText, :newText),
             updated_at = :now
       WHERE slug = 'epic-task-workflow'`,
      {
        replacements: {
          oldText: OLD_TOOL_ROW_UPDATE_STAGE,
          newText: NEW_TOOL_ROW_UPDATE_STAGE,
          now,
        },
      },
    );

    // 4. Add English rule to the Rules section
    await queryInterface.sequelize.query(
      `UPDATE skills
         SET skill_text = REPLACE(skill_text, :oldText, :newText),
             updated_at = :now
       WHERE slug = 'epic-task-workflow'`,
      {
        replacements: {
          oldText: OLD_LAST_RULES,
          newText: NEW_LAST_RULES,
          now,
        },
      },
    );
  },

  async down(queryInterface) {
    const now = new Date();

    // Reverse in opposite order
    await queryInterface.sequelize.query(
      `UPDATE skills
         SET skill_text = REPLACE(skill_text, :newText, :oldText),
             updated_at = :now
       WHERE slug = 'epic-task-workflow'`,
      {
        replacements: {
          oldText: OLD_LAST_RULES,
          newText: NEW_LAST_RULES,
          now,
        },
      },
    );

    await queryInterface.sequelize.query(
      `UPDATE skills
         SET skill_text = REPLACE(skill_text, :newText, :oldText),
             updated_at = :now
       WHERE slug = 'epic-task-workflow'`,
      {
        replacements: {
          oldText: OLD_TOOL_ROW_UPDATE_STAGE,
          newText: NEW_TOOL_ROW_UPDATE_STAGE,
          now,
        },
      },
    );

    await queryInterface.sequelize.query(
      `UPDATE skills
         SET skill_text = REPLACE(skill_text, :newText, :oldText),
             updated_at = :now
       WHERE slug = 'epic-task-workflow'`,
      {
        replacements: {
          oldText: OLD_BETWEEN_STAGES,
          newText: NEW_BETWEEN_STAGES,
          now,
        },
      },
    );

    await queryInterface.sequelize.query(
      `UPDATE skills
         SET skill_text = REPLACE(skill_text, :newText, :oldText),
             updated_at = :now
       WHERE slug = 'epic-task-workflow'`,
      {
        replacements: {
          oldText: OLD_TASK_DESC_INSTRUCTION,
          newText: NEW_TASK_DESC_INSTRUCTION,
          now,
        },
      },
    );
  },
};
