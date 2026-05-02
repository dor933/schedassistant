"use strict";

/**
 * Step 2 of slice 17's `claude_sub_agent` enum addition.
 *
 * Migration 130 added `'claude_sub_agent'` as a value on the
 * `enum_agents_type` ENUM. This migration uses that newly-committed
 * enum value to widen the `owning_primary_agent_id` CHECK constraint:
 * previously it required the owning row to be `type = 'system'`; now
 * `type IN ('system', 'claude_sub_agent')` is allowed, so admin-created
 * sub-agents can carry a non-NULL owner.
 *
 * Why split from 130:
 *   `ALTER TYPE … ADD VALUE` cannot be referenced in the same
 *   transaction it ran in. sequelize-cli wraps each migration's `up()`
 *   in a transaction, so the constraint creation has to live in a later
 *   migration that runs after 130's transaction commits.
 *
 * Idempotent: drops the old constraint with `IF EXISTS` and uses a new
 * constraint name, so re-running on partial state (e.g. a deployment
 * where the buggy original migration 130 dropped the old constraint
 * before failing on the new one) reaches the right end state.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, _Sequelize) {
    // Drop the migration-101 constraint if it's still present, AND drop
    // any previously-attempted name from the buggy migration-130 retry
    // loop. Both are no-ops when absent.
    await queryInterface.sequelize.query(
      `ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_owner_only_for_system;`,
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_owner_only_for_system_or_sub_agent;`,
    );

    // Now create the widened constraint. The literal `'claude_sub_agent'`
    // is valid here because migration 130 added it to the enum and that
    // transaction has committed by the time this migration runs.
    await queryInterface.sequelize.query(
      `ALTER TABLE agents
         ADD CONSTRAINT agents_owner_only_for_system_or_sub_agent
         CHECK (
           owning_primary_agent_id IS NULL
           OR type IN ('system', 'claude_sub_agent')
         );`,
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_owner_only_for_system_or_sub_agent;`,
    );
    // Restore the migration-101 narrow constraint. If any claude_sub_agent
    // rows have non-NULL owners this will fail; admins must clear those
    // assignments before rolling back.
    await queryInterface.sequelize.query(
      `ALTER TABLE agents
         ADD CONSTRAINT agents_owner_only_for_system
         CHECK (owning_primary_agent_id IS NULL OR type = 'system');`,
    );
  },
};
