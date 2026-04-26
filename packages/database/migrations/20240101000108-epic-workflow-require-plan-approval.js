"use strict";

/**
 * Updates the `epic-task-workflow` skill to REQUIRE explicit user approval
 * of the proposed plan before the orchestrator calls `create_epic_plan`.
 *
 * Motivation: epics cannot be edited after creation. When the orchestrator
 * jumped straight from "I see what you want" to `create_epic_plan` with the
 * wrong stages or tasks, the only recovery was to cancel the epic and rebuild
 * it from scratch — which burns the system-wide singleton-active-epic slot
 * and forces the user to clean up. We want the wrong-plan to be caught in
 * chat, not in the database.
 *
 * Two surgical REPLACEs:
 *   1. Prepend a "Confirm the plan with the user FIRST (REQUIRED)" subsection
 *      to Phase 2, immediately before "### Create the epic". The anchor we
 *      replace is taken verbatim from the 049 seed and was not modified by
 *      any later migration, so the REPLACE matches once.
 *   2. Tighten rule #3 ("Never skip the planning phase") to also require
 *      explicit user approval before calling `create_epic_plan`. Rule
 *      numbering after migration 062 is 1..9; rule #3 is unique in the doc.
 *
 * @type {import('sequelize-cli').Migration}
 */

const SKILL_SLUG = "epic-task-workflow";

// ─── 1. Insert "Confirm the plan with the user" before "### Create the epic" ─

const OLD_CREATE_EPIC_BLOCK = `### Create the epic
Call the \`create_epic_plan\` tool with:
- \`title\` — concise name for the epic`;

const NEW_CREATE_EPIC_BLOCK = `### Confirm the plan with the user FIRST (REQUIRED)

**STOP. Do NOT call \`create_epic_plan\` until the user has explicitly approved the plan in this conversation.**

Why this matters: an epic cannot be edited after creation. If you create the wrong stages or tasks, the only way to recover is to cancel the epic and rebuild it from scratch — which burns the system-wide singleton-active-epic slot and forces the user to clean up after you. Catch mistakes **before** they hit the database.

Procedure:

1. Present the proposed plan to the user **in chat**, in this format:
   - The epic title.
   - For each stage: stage name + ordered list of task titles (short titles are enough — the user just needs to validate the shape of the plan, not the full task descriptions).
2. Ask explicitly, in your own words, something like: *"Does this plan look right? Reply 'approve plan' or tell me what to change before I create the epic."*
3. Wait for the user's reply in the next turn.
   - If they ask for changes (add/remove/reorder stages or tasks, edit titles, change scope) — revise the plan and re-present it. Loop until they approve.
   - Only proceed once the user has clearly approved (e.g. "approve plan", "looks good, create it", "yes go ahead").
4. Calling \`create_epic_plan\` without that explicit user approval is a workflow violation. Do not do it.

### Create the epic
Call the \`create_epic_plan\` tool with:
- \`title\` — concise name for the epic`;

// ─── 2. Tighten rule #3 (post-062 numbering) ───────────────────────────────

const OLD_RULE_3 =
  '3. **Never skip the planning phase** — even for "simple" requests, create a proper epic.';

const NEW_RULE_3 =
  '3. **Never skip the planning phase, and NEVER call `create_epic_plan` until the user has explicitly approved the proposed plan in chat.** Even for "simple" requests, present the stages and tasks first and wait for the user\'s confirmation. Epics cannot be edited after creation — a wrong plan forces the user to cancel and rebuild from scratch.';

// ─── Helper ───────────────────────────────────────────────────────────────

async function applyReplace(queryInterface, oldText, newText, now) {
  await queryInterface.sequelize.query(
    `UPDATE skills
       SET skill_text = REPLACE(skill_text, :oldText, :newText),
           updated_at = :now
     WHERE slug = :slug`,
    { replacements: { oldText, newText, now, slug: SKILL_SLUG } },
  );
}

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    await applyReplace(queryInterface, OLD_CREATE_EPIC_BLOCK, NEW_CREATE_EPIC_BLOCK, now);
    await applyReplace(queryInterface, OLD_RULE_3, NEW_RULE_3, now);
  },

  async down(queryInterface) {
    const now = new Date();
    await applyReplace(queryInterface, NEW_RULE_3, OLD_RULE_3, now);
    await applyReplace(queryInterface, NEW_CREATE_EPIC_BLOCK, OLD_CREATE_EPIC_BLOCK, now);
  },
};
