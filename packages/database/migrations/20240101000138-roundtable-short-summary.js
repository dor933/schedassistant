"use strict";

/**
 * Adds `short_summary` to `roundtables` — a one-paragraph distillation
 * of the long `summary`, generated alongside it when a roundtable
 * completes.
 *
 * Why a second column instead of letting agents always read `summary`:
 *   The long summary follows the structured "Topic / Key Points /
 *   Agreements / Disagreements / Per-Agent Contributions" template
 *   (~350 words). For typical agent recall ("which roundtables touched
 *   on X, and what was decided?") that's far more than needed. The
 *   short_summary is a single paragraph the agent can pull cheaply via
 *   the new `get_roundtable_overview` tool, escalating to the full
 *   `summary` only when more depth is required. Keeping both lets the
 *   agent triage cheaply without losing the detailed version.
 *
 * Backfill: deliberately not run. Existing roundtables stay with
 *   `short_summary = NULL`; the recall tool falls back to the long
 *   summary in that case. New roundtables get both populated by the
 *   summarizer.
 *
 * Idempotent (`IF NOT EXISTS`) so this migration can rerun cleanly.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE roundtables
         ADD COLUMN IF NOT EXISTS short_summary TEXT`,
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("roundtables", "short_summary");
  },
};
