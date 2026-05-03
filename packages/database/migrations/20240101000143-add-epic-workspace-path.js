"use strict";

/**
 * Add `epic_tasks.workspace_path` — the per-epic shared workspace folder.
 *
 * Layout (sibling to the existing per-thread `threads/<id>/` folders):
 *
 *     <orchestrator-agent.workspace_path>/epics/<epic-id>/
 *
 * Why per-epic and not per-task: sub-agents dispatched via `Task()` do not
 * carry memory across separate task dispatches, so files written during
 * task N are invisible to the sub-agent running task N+1 unless they live
 * at a path the orchestrator can re-state in every dispatch scope. A
 * per-epic folder is the most stable known location: orchestration spans
 * many tasks but always one epic, and the epic id is stable.
 *
 * Why not under `threads/<id>/`: threads can rotate (long conversations
 * get summarized into a fresh thread) but the epic's filesystem state
 * needs to outlive that rotation. A sibling `epics/` directory keeps the
 * folder reachable as long as the orchestrator agent's workspace exists.
 *
 * Code edits still go to the repo cwd — this folder is for non-repo
 * deliverables (research notes, scratch markdown, plan stage outputs,
 * intermediate artifacts the next task will read, …).
 *
 * Backfill policy: NULL for pre-existing rows by design — the user asked
 * for "existing epics should stay as they are now". `start_epic_task`
 * tolerates a null value (just doesn't surface a workspace path to
 * sub-agents); only newly-created epics get the column populated by the
 * `createEpicWithPlan` helper.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("epic_tasks", "workspace_path", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("epic_tasks", "workspace_path");
  },
};
