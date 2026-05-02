"use strict";

/**
 * Adds the `claude_sub_agent` value to the `enum_agents_type` Postgres
 * ENUM (slice 17). This is step 1 of two — the CHECK constraint that
 * actually USES the new enum value lives in a separate later migration
 * (`20240101000135-add-claude-sub-agent-check-constraint.js`).
 *
 * Why split into two migrations:
 *   Postgres requires `ALTER TYPE … ADD VALUE` to be COMMITTED before
 *   the new enum value can be referenced in any other DDL — including
 *   CHECK constraints that compare a column to the literal. sequelize-cli
 *   wraps each migration's `up()` in a single transaction, so doing both
 *   in one migration fails with `invalid input value for enum
 *   enum_agents_type: "claude_sub_agent"` at the constraint-creation step.
 *   Same pattern migrations 78 (external) and 109 (application) used —
 *   they each add a single enum value and nothing else.
 *
 * The CHECK widening that *consumes* the new value lands in migration
 * 135 (also re-runs idempotently if migration 130 already executed
 * before this fix). See that migration for the constraint logic.
 *
 * Differences between `claude_sub_agent` and `system` (consumed by the
 * runtime, not enforced here):
 *   1. A claude_sub_agent is owned by EXACTLY ONE primary at a time
 *      (or NULL = unassigned/available). NULL is "available to be
 *      attached"; never org-wide-shared the way some system agents are.
 *   2. Exposed to the Claude Agent SDK runner via the `agents:`
 *      parameter only — never via `list_system_agents` /
 *      `delegate_to_deep_agent`. (No deepagents-worker path.)
 *   3. The owning primary MUST run on an Anthropic-vendor model.
 *      Cascade-clear in `agents.service.ts:update` enforces this.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_agents_type" ADD VALUE IF NOT EXISTS 'claude_sub_agent'`,
    );
  },

  async down(_queryInterface, _Sequelize) {
    // Postgres ENUM values can't be removed cleanly without rebuilding
    // the type — same caveat migrations 78 and 109 noted. Leaving the
    // value in place on rollback is the safe choice; rolling back the
    // CHECK widening (migration 135) is enough to restore the previous
    // semantic state.
  },
};
