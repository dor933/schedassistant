"use strict";

/**
 * Adds `owning_primary_agent_id` to `agents` — a self-referential nullable FK
 * that scopes a system agent to a specific primary agent.
 *
 * Semantics:
 *   - NULL          → shared / org-wide. Any primary in the org may delegate
 *                     to it. This is what every existing system agent has
 *                     after the migration runs (org-wide pattern preserved
 *                     for `google_workspace_agent`, the active web-search
 *                     agent, and any other shared specialist).
 *   - non-NULL      → private. Only the named primary agent may discover
 *                     (`list_system_agents`) or delegate (`delegate_to_deep_agent`)
 *                     to this executor. Tools enforce this in the app layer.
 *
 * Constraints:
 *   - ON DELETE SET NULL — deleting a primary doesn't cascade-delete its
 *     specialists; they fall back to shared/unowned.
 *   - CHECK (owning_primary_agent_id IS NULL OR type = 'system') — only
 *     system agents may be owned. Primary and external agents stay unowned
 *     by definition.
 *
 * Backwards compatible: every existing row defaults to NULL (shared), so no
 * delegation flow changes until an admin explicitly assigns ownership.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("agents", "owning_primary_agent_id", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "agents", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    });

    // Partial index — only scan the rows that actually have an owner. The
    // shared (NULL) rows are the majority and never queried by this column.
    await queryInterface.sequelize.query(
      `CREATE INDEX idx_agents_owning_primary
         ON agents(owning_primary_agent_id)
         WHERE owning_primary_agent_id IS NOT NULL;`,
    );

    // Schema-level guarantee that ownership only attaches to system rows.
    // App-layer tools also enforce this, but the CHECK catches any out-of-band
    // mutation (manual SQL, future admin UI, seeds).
    await queryInterface.sequelize.query(
      `ALTER TABLE agents
         ADD CONSTRAINT agents_owner_only_for_system
         CHECK (owning_primary_agent_id IS NULL OR type = 'system');`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_owner_only_for_system;`,
    );
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS idx_agents_owning_primary;`,
    );
    await queryInterface.removeColumn("agents", "owning_primary_agent_id");
  },
};
