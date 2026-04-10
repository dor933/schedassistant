"use strict";

/**
 * Updates the `epic-task-workflow` skill text with:
 * 1. The "only one active epic at a time SYSTEM-WIDE" rule, matching the new
 *    guard in CreateEpicPlanTool (which blocks globally across all users and
 *    projects — the Epic Orchestrator is a shared singleton agent).
 * 2. Documentation for the new `force_approve_stage_pr` tool, including the
 *    strict usage rule: it requires an explicit user authorization quote and
 *    must NEVER be called autonomously.
 *
 * Done via targeted REPLACE calls so the migration is idempotent and does
 * not clobber unrelated edits.
 *
 * @type {import('sequelize-cli').Migration}
 */

// ─── 1. Single-epic rule ────────────────────────────────────────────────────

const OLD_RULES_HEADER = `## Rules

1. **Always confirm project and repos** before creating an epic — never guess.`;

const NEW_RULES_HEADER = `## Rules

1. **Only ONE active epic at a time SYSTEM-WIDE.** The Epic Orchestrator is a shared singleton — exactly one epic can run at a time across all users and projects. The system enforces this: \`create_epic_plan\` will refuse if any epic is already pending or in progress, even for another user. If the user asks for a new epic while one is active, inform them of the existing epic (including whose it is, if not theirs) and ask whether to finish, cancel, or defer the new work.
2. **Always confirm project and repos** before creating an epic — never guess.`;

// Also renumber the remaining rules so the list stays consistent (2→3, 3→4, ...).
const OLD_REST_OF_RULES = `2. **Never skip the planning phase** — even for "simple" requests, create a proper epic.
3. **Review every execution result using the diff** — do not rely only on the CLI summary. The git diff is the source of truth for what changed.
4. **Provide actionable, diff-specific feedback** on retries — reference specific files and changes. "fix it" is not good feedback.
5. **Keep the user informed** — report progress at stage boundaries.
6. **Do not modify the epic structure** after creation — if the plan needs to change, discuss with the user first.
7. **Use review_task_diff** when the execution report diff is truncated or you need to compare against the base branch before approving.`;

const NEW_REST_OF_RULES = `3. **Never skip the planning phase** — even for "simple" requests, create a proper epic.
4. **Review every execution result using the diff** — do not rely only on the CLI summary. The git diff is the source of truth for what changed.
5. **Provide actionable, diff-specific feedback** on retries — reference specific files and changes. "fix it" is not good feedback.
6. **Keep the user informed** — report progress at stage boundaries.
7. **Do not modify the epic structure** after creation — if the plan needs to change, discuss with the user first.
8. **Use review_task_diff** when the execution report diff is truncated or you need to compare against the base branch before approving.
9. **NEVER call \`force_approve_stage_pr\` on your own initiative.** See the tool reference below for the strict usage rule.`;

// ─── 2. Tool reference — add force_approve_stage_pr row ─────────────────────

const OLD_TOOL_TABLE_TAIL = `| \`update_stage_pr\` | Link a PR URL to a stage after creating it |
| \`run_command\` | Run shell commands (git, gh) via the **bash MCP** — use for pushing branches and creating PRs |`;

const NEW_TOOL_TABLE_TAIL = `| \`update_stage_pr\` | Fallback: manually link a PR URL to a stage (auto-creation normally handles this) |
| \`force_approve_stage_pr\` | **DESTRUCTIVE** — bypass PR webhook and mark a stage's PR as approved. Requires explicit user authorization quote. See usage rule below. |
| \`run_command\` | Run shell commands (git, gh) via the **bash MCP** — for general shell operations |

---

## Force-Approving a Stage PR (bypassing the webhook)

The \`force_approve_stage_pr\` tool manually marks a stage's PR as approved — bypassing the automated GitHub webhook that normally drives the approval flow. Triggering it starts the next stage's tasks as if the real approval had arrived.

**This tool is DESTRUCTIVE and must only be used under all of these conditions:**

1. The user has **explicitly stated in this conversation** that they have manually reviewed and approved the PR (for example: they went to GitHub, read the diff, and approved it there themselves).
2. The user has **explicitly instructed you to proceed** without waiting for the automatic webhook.
3. You can **quote the exact user message** that granted this authorization — the tool requires a \`userConfirmationQuote\` field with that verbatim text.

**Do NOT call this tool:**
- Because the webhook seems slow or broken.
- Because you think the PR "looks fine".
- Because the user asked you to "finish the epic" without mentioning the PR explicitly.
- To work around a failed \`execute_epic_task\` call.
- On your own initiative, for any reason.

**If the user says something ambiguous** like "just continue", ask them: *"To confirm — have you manually reviewed and approved the PR on GitHub, and do you want me to bypass the automated approval and proceed with the next stage?"* Only proceed after they answer yes unambiguously.

When you do call it, the tool re-uses the same internal flow as the real webhook — the next stage's tasks become ready and auto-continuation picks them up.`;

module.exports = {
  async up(queryInterface) {
    const now = new Date();

    // Replace the rules header (adds rule #1 about single active epic)
    await queryInterface.sequelize.query(
      `UPDATE skills
         SET skill_text = REPLACE(skill_text, :oldText, :newText),
             updated_at = :now
       WHERE slug = 'epic-task-workflow'`,
      {
        replacements: {
          oldText: OLD_RULES_HEADER,
          newText: NEW_RULES_HEADER,
          now,
        },
      },
    );

    // Renumber the remaining rules and add the force-approve rule
    await queryInterface.sequelize.query(
      `UPDATE skills
         SET skill_text = REPLACE(skill_text, :oldText, :newText),
             updated_at = :now
       WHERE slug = 'epic-task-workflow'`,
      {
        replacements: {
          oldText: OLD_REST_OF_RULES,
          newText: NEW_REST_OF_RULES,
          now,
        },
      },
    );

    // Add force_approve_stage_pr to the tool reference + append the usage section
    await queryInterface.sequelize.query(
      `UPDATE skills
         SET skill_text = REPLACE(skill_text, :oldText, :newText),
             updated_at = :now
       WHERE slug = 'epic-task-workflow'`,
      {
        replacements: {
          oldText: OLD_TOOL_TABLE_TAIL,
          newText: NEW_TOOL_TABLE_TAIL,
          now,
        },
      },
    );
  },

  async down(queryInterface) {
    const now = new Date();

    await queryInterface.sequelize.query(
      `UPDATE skills
         SET skill_text = REPLACE(skill_text, :newText, :oldText),
             updated_at = :now
       WHERE slug = 'epic-task-workflow'`,
      {
        replacements: {
          oldText: OLD_TOOL_TABLE_TAIL,
          newText: NEW_TOOL_TABLE_TAIL,
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
          oldText: OLD_REST_OF_RULES,
          newText: NEW_REST_OF_RULES,
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
          oldText: OLD_RULES_HEADER,
          newText: NEW_RULES_HEADER,
          now,
        },
      },
    );
  },
};
