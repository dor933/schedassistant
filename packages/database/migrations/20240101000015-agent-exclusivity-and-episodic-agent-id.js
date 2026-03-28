"use strict";

/**
 * Architectural change: exclusive agent assignment + agent-level memory.
 *
 * 1. Add `single_chat_id` and `group_id` columns to `agents` (nullable, UNIQUE).
 *    CHECK: both cannot be non-null simultaneously.
 * 2. Add `agent_id` column to `episodic_memory` and `threads`.
 * 3. Backfill:
 *    a. For each single_chat using the shared DEFAULT_AGENT, create a new
 *       agent clone and re-point the single_chat.
 *    b. Link each agent to its single_chat or group via the new columns.
 *    c. Backfill agent_id in episodic_memory and threads.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const DEFAULT_AGENT_ID = "00000000-0000-4000-a000-000000000001";

    // ── 1. Add columns to agents ──────────────────────────────────────────────
    await queryInterface.addColumn("agents", "single_chat_id", {
      type: Sequelize.UUID,
      allowNull: true,
      unique: true,
      references: { model: "single_chats", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    });

    await queryInterface.addColumn("agents", "group_id", {
      type: Sequelize.UUID,
      allowNull: true,
      unique: true,
      references: { model: "groups", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    });

    // CHECK: at most one can be non-null
    await queryInterface.sequelize.query(`
      ALTER TABLE agents
      ADD CONSTRAINT agents_exclusive_attachment
      CHECK (NOT (single_chat_id IS NOT NULL AND group_id IS NOT NULL))
    `);

    // ── 2. Add agent_id to episodic_memory ────────────────────────────────────
    await queryInterface.addColumn("episodic_memory", "agent_id", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "agents", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    });

    await queryInterface.addIndex("episodic_memory", ["agent_id"], {
      name: "episodic_memory_agent_id",
    });

    // ── 3. Add agent_id to threads ────────────────────────────────────────────
    await queryInterface.addColumn("threads", "agent_id", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "agents", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    });

    await queryInterface.addIndex("threads", ["agent_id"], {
      name: "threads_agent_id",
    });

    // Composite index for session summary loading by agent
    await queryInterface.addIndex("threads", [
      { name: "agent_id", order: "ASC" },
      { name: "summarized_at", order: "DESC" },
    ], { name: "threads_agent_id_summarized_at" });

    // ── 4. Backfill: clone DEFAULT agent for each single_chat ─────────────────
    const [defaultAgents] = await queryInterface.sequelize.query(
      `SELECT definition, core_instructions FROM agents WHERE id = :id`,
      { replacements: { id: DEFAULT_AGENT_ID } },
    );
    const defaultDef = defaultAgents[0]?.definition ?? null;
    const defaultInstr = defaultAgents[0]?.core_instructions ?? null;

    // Find all single_chats using the default agent
    const [singleChats] = await queryInterface.sequelize.query(
      `SELECT id, user_id FROM single_chats WHERE agent_id = :agentId`,
      { replacements: { agentId: DEFAULT_AGENT_ID } },
    );

    for (const sc of singleChats) {
      await queryInterface.sequelize.query(
        `INSERT INTO agents (id, definition, core_instructions, single_chat_id, created_at, updated_at)
         VALUES (gen_random_uuid(), :definition, :instructions, :scId, NOW(), NOW())
         RETURNING id`,
        {
          replacements: {
            definition: defaultDef,
            instructions: defaultInstr,
            scId: sc.id,
          },
        },
      ).then(async ([rows]) => {
        const newId = rows[0].id;
        // Re-point the single_chat to the new agent
        await queryInterface.sequelize.query(
          `UPDATE single_chats SET agent_id = :newId WHERE id = :scId`,
          { replacements: { newId, scId: sc.id } },
        );
      });
    }

    // ── 5. Link agents to their groups ────────────────────────────────────────
    await queryInterface.sequelize.query(`
      UPDATE agents a
      SET group_id = g.id
      FROM groups g
      WHERE g.agent_id = a.id
        AND a.group_id IS NULL
        AND a.single_chat_id IS NULL
    `);

    // Link agents to their single_chats (those not already linked via step 4)
    await queryInterface.sequelize.query(`
      UPDATE agents a
      SET single_chat_id = sc.id
      FROM single_chats sc
      WHERE sc.agent_id = a.id
        AND a.single_chat_id IS NULL
        AND a.group_id IS NULL
    `);

    // ── 6. Backfill threads.agent_id ──────────────────────────────────────────
    // Via single_chat
    await queryInterface.sequelize.query(`
      UPDATE threads t
      SET agent_id = sc.agent_id
      FROM single_chats sc
      WHERE sc.id = t.single_chat_id
        AND t.agent_id IS NULL
    `);

    // Via group
    await queryInterface.sequelize.query(`
      UPDATE threads t
      SET agent_id = g.agent_id
      FROM groups g
      WHERE g.id = t.group_id
        AND t.agent_id IS NULL
    `);

    // ── 7. Backfill episodic_memory.agent_id ──────────────────────────────────
    await queryInterface.sequelize.query(`
      UPDATE episodic_memory em
      SET agent_id = t.agent_id
      FROM threads t
      WHERE em.thread_id = t.id
        AND em.agent_id IS NULL
        AND t.agent_id IS NOT NULL
    `);
  },

  async down(queryInterface, _Sequelize) {
    // Remove threads.agent_id
    await queryInterface.removeIndex("threads", "threads_agent_id_summarized_at");
    await queryInterface.removeIndex("threads", "threads_agent_id");
    await queryInterface.removeColumn("threads", "agent_id");

    // Remove episodic_memory.agent_id
    await queryInterface.removeIndex("episodic_memory", "episodic_memory_agent_id");
    await queryInterface.removeColumn("episodic_memory", "agent_id");

    // Remove CHECK constraint
    await queryInterface.sequelize.query(`
      ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_exclusive_attachment
    `);

    // Remove columns from agents
    await queryInterface.removeColumn("agents", "group_id");
    await queryInterface.removeColumn("agents", "single_chat_id");
  },
};
