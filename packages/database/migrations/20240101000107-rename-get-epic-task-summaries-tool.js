"use strict";

/**
 * Renames the `get_epic_task_summaries` tool to `get_epic_task_stages_and_tasks`.
 *
 * Why a follow-up migration: 20240101000105 was already applied on existing
 * databases with the OLD slug. The original migration's
 * `ON CONFLICT (slug) DO NOTHING` makes re-running it a no-op against the
 * existing row, so editing 105 in place does not propagate the rename to a
 * DB that has already run it. We need an explicit UPDATE here.
 *
 * Updating in place (rather than DELETE + INSERT) is deliberate: the row's
 * surrogate `id` is referenced by `agent_available_tools.tool_id`, so any
 * agent the tool was already assigned to keeps its binding unchanged. Only
 * `slug` / `name` / `description` change.
 *
 * Idempotent on both up and down — guards check the current slug before
 * mutating, so re-running is safe.
 *
 * @type {import('sequelize-cli').Migration}
 */

const OLD_SLUG = "get_epic_task_summaries";
const NEW_SLUG = "get_epic_task_stages_and_tasks";

const NEW_NAME = "Get Epic Task Stages and Tasks";
const NEW_DESCRIPTION =
  "Returns the complete stage + task structure of an epic, organized hierarchically — every " +
  "stage with its metadata (title, description, kind, status, PR info) and every task under " +
  "each stage (title, description, status, summary file path, timestamps). Use after " +
  "search_epic_tasks_by_date to deliver summaries, browse scope, find a stage's PR, or reuse " +
  "a stage/task description in a new create_epic_plan.";

const OLD_NAME = "Get Epic Task Summaries";
const OLD_DESCRIPTION =
  "Returns the saved per-task summary file paths for a given epic. Use after identifying the epic " +
  "via search_epic_tasks_by_date — pass each path to send_file_to_user to deliver as chat attachments.";

module.exports = {
  async up(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `UPDATE tools
          SET slug        = :newSlug,
              name        = :newName,
              description = :newDescription,
              updated_at  = NOW()
        WHERE slug = :oldSlug`,
      {
        replacements: {
          oldSlug: OLD_SLUG,
          newSlug: NEW_SLUG,
          newName: NEW_NAME,
          newDescription: NEW_DESCRIPTION,
        },
      },
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `UPDATE tools
          SET slug        = :oldSlug,
              name        = :oldName,
              description = :oldDescription,
              updated_at  = NOW()
        WHERE slug = :newSlug`,
      {
        replacements: {
          oldSlug: OLD_SLUG,
          newSlug: NEW_SLUG,
          oldName: OLD_NAME,
          oldDescription: OLD_DESCRIPTION,
        },
      },
    );
  },
};
