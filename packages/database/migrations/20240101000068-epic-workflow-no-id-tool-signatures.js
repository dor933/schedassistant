"use strict";

/**
 * Updates the `epic-task-workflow` skill text to match the new ID-less
 * tool signatures.
 *
 * The epic orchestrator is a system-wide singleton: at any moment there is
 * at most one active epic, and within it at most one stage in pr_pending.
 * The tools now resolve the active epic/stage/task from DB state rather
 * than accepting UUID arguments — this prevents the model from hallucinating
 * IDs across turns (a problem we observed in production).
 *
 * This migration rewrites the parts of the skill text that still instruct
 * the model to pass `epicId`, `stageId`, or `taskId` arguments, so the
 * documented tool calls match the new schemas.
 *
 * @type {import('sequelize-cli').Migration}
 */

// ─── 1. Execute-epic-task invocation line (from the 049 seed) ─────────────

const OLD_EXECUTE_LINE =
  '1. Call `execute_epic_task` with `epicId` — this picks the next ready task automatically.';

const NEW_EXECUTE_LINE =
  '1. Call `execute_epic_task` (no arguments) — it auto-resolves the active epic and picks the next ready task.';

// ─── 2. Retry-on-fix instruction (from the 049 seed) ──────────────────────

const OLD_RETRY_INSTRUCTION =
  '**If it fails or needs fixes:** Call `execute_epic_task` with `mode: "retry"`, the same `taskId`, and specific feedback referencing the diff lines that need to change. The executor receives your feedback and its previous diff. **The system will attempt the retry from the same place (re-trying the exact session). Once successful, it will automatically resume executing the remaining tasks.**';

const NEW_RETRY_INSTRUCTION =
  '**If it needs fixes:** Call `request_stage_changes` with specific feedback referencing the diff lines that need to change (no stage ID needed — it resolves the unique pr_pending stage automatically). Then call `execute_epic_task` with `mode: "retry"` (no arguments needed — feedback is loaded from the stored execution, and the previous CLI session is resumed for full context). **The system re-runs the stage with your feedback, then pushes the fixes to the existing PR.**';

// ─── 3. Approve-stage & request-stage-changes instructions (from 065) ─────

const OLD_APPROVE_PATH =
  '2. **Chat (manual):** The user says "approve it" or "looks good" in the conversation → call `approve_stage` with the stage ID and a verbatim quote of their approval → same effect.';

const NEW_APPROVE_PATH =
  '2. **Chat (manual):** The user says "approve it" or "looks good" in the conversation → call `approve_stage` with a verbatim quote of their approval (no stage ID needed — it resolves the unique pr_pending stage automatically) → same effect.';

const OLD_REQUEST_CHANGES_BLOCK =
  '**Requesting changes from chat:**\n' +
  '- If the user reviews the PR/diff and wants fixes, call `request_stage_changes` with the stage ID and their feedback.\n' +
  '- This resets the stage from `pr_pending` back to `in_progress`, resets completed tasks to `ready`, and stores the feedback.\n' +
  '- Then retry each task using `execute_epic_task` with `mode="retry"` — the previous CLI session is resumed automatically.\n' +
  '- After fixes, the stage returns to `pr_pending` and fixes are pushed to the existing PR.';

const NEW_REQUEST_CHANGES_BLOCK =
  '**Requesting changes from chat:**\n' +
  '- If the user reviews the PR/diff and wants fixes, call `request_stage_changes` with their feedback (no stage ID — it resolves the unique pr_pending stage automatically).\n' +
  '- This resets the stage from `pr_pending` back to `in_progress`, resets completed tasks to `ready`, and stores the feedback on each task.\n' +
  '- Then call `execute_epic_task` with `mode="retry"` (no arguments needed — feedback is auto-loaded, and the previous CLI session is resumed).\n' +
  '- After fixes, the stage returns to `pr_pending` and fixes are pushed to the existing PR.';

// ─── 4. Singleton-orchestrator note prepended to Phase 3 ─────────────────
//
// Replace the Phase 3 header to add an explicit note that all epic tools
// auto-resolve the active epic — so the model never has to track or pass
// any epic/stage/task IDs between turns. This is the single most important
// behavioral change, so it gets front-page billing.

const OLD_PHASE_3_HEADER =
  '## Phase 3: Execute & Review Tasks\n\n' +
  'After the epic is created, tasks within the first stage will begin executing automatically, one by one, based on their sort order.';

const NEW_PHASE_3_HEADER =
  '## Phase 3: Execute & Review Tasks\n\n' +
  '**Important:** The epic orchestrator is a system-wide singleton — only one epic is ever active at a time. ' +
  'Every epic tool (`execute_epic_task`, `get_epic_status`, `request_stage_changes`, `approve_stage`, ' +
  '`force_approve_stage_pr`, `update_stage_pr`) auto-resolves the active epic and the unique stage/task ' +
  'they target from DB state. **You never pass `epicId`, `stageId`, or `taskId` to these tools** — the ' +
  'schemas do not accept them. Do not attempt to remember or reconstruct IDs across turns.\n\n' +
  'After the epic is created, tasks within the first stage will begin executing automatically, one by one, based on their sort order.';

// ─── Helper ───────────────────────────────────────────────────────────────

async function applyReplace(queryInterface, oldText, newText, now) {
  await queryInterface.sequelize.query(
    `UPDATE skills
       SET skill_text = REPLACE(skill_text, :oldText, :newText),
           updated_at = :now
     WHERE slug = 'epic-task-workflow'`,
    { replacements: { oldText, newText, now } },
  );
}

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    await applyReplace(queryInterface, OLD_EXECUTE_LINE, NEW_EXECUTE_LINE, now);
    await applyReplace(queryInterface, OLD_RETRY_INSTRUCTION, NEW_RETRY_INSTRUCTION, now);
    await applyReplace(queryInterface, OLD_APPROVE_PATH, NEW_APPROVE_PATH, now);
    await applyReplace(queryInterface, OLD_REQUEST_CHANGES_BLOCK, NEW_REQUEST_CHANGES_BLOCK, now);
    await applyReplace(queryInterface, OLD_PHASE_3_HEADER, NEW_PHASE_3_HEADER, now);
  },

  async down(queryInterface) {
    const now = new Date();
    // Reverse in opposite order (REPLACE is symmetric with swapped args).
    await applyReplace(queryInterface, NEW_PHASE_3_HEADER, OLD_PHASE_3_HEADER, now);
    await applyReplace(queryInterface, NEW_REQUEST_CHANGES_BLOCK, OLD_REQUEST_CHANGES_BLOCK, now);
    await applyReplace(queryInterface, NEW_APPROVE_PATH, OLD_APPROVE_PATH, now);
    await applyReplace(queryInterface, NEW_RETRY_INSTRUCTION, OLD_RETRY_INSTRUCTION, now);
    await applyReplace(queryInterface, NEW_EXECUTE_LINE, OLD_EXECUTE_LINE, now);
  },
};
