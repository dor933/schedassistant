"use strict";

/**
 * Episodic memory + threads: `agent_id` for scoping.
 *
 * - Add `agent_id` to `episodic_memory` and `threads` (with indexes).
 * - Backfill: clone DEFAULT agent per single_chat row that still points at the
 *   default agent (legacy one-agent-per-chat cleanup), then link episodic rows
 *   from threads when set.
 *
 * Canonical LangGraph thread id lives only on `agents.active_thread_id` (see
 * create-agents migration). There is no `agents.group_id`; groups reference
 * agents via `groups.agent_id` only.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const DEFAULT_AGENT_ID = "00000000-0000-4000-a000-000000000001";

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

    await queryInterface.addIndex("threads", [
      { name: "agent_id", order: "ASC" },
      { name: "summarized_at", order: "DESC" },
    ], { name: "threads_agent_id_summarized_at" });

    const [defaultAgents] = await queryInterface.sequelize.query(
      `SELECT definition, core_instructions FROM agents WHERE id = :id`,
      { replacements: { id: DEFAULT_AGENT_ID } },
    );
    const defaultDef = defaultAgents[0]?.definition ?? null;
    const defaultInstr = defaultAgents[0]?.core_instructions ?? null;

    const [singleChats] = await queryInterface.sequelize.query(
      `SELECT id, user_id FROM single_chats WHERE agent_id = :agentId`,
      { replacements: { agentId: DEFAULT_AGENT_ID } },
    );

    for (const sc of singleChats) {
      await queryInterface.sequelize.query(
        `INSERT INTO agents (id, definition, core_instructions, created_at, updated_at)
         VALUES (gen_random_uuid(), :definition, :instructions, NOW(), NOW())
         RETURNING id`,
        {
          replacements: {
            definition: defaultDef,
            instructions: defaultInstr,
          },
        },
      ).then(async ([rows]) => {
        const newId = rows[0].id;
        await queryInterface.sequelize.query(
          `UPDATE single_chats SET agent_id = :newId WHERE id = :scId`,
          { replacements: { newId, scId: sc.id } },
        );
      });
    }

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
    await queryInterface.removeIndex("threads", "threads_agent_id_summarized_at");
    await queryInterface.removeIndex("threads", "threads_agent_id");
    await queryInterface.removeColumn("threads", "agent_id");

    await queryInterface.removeIndex("episodic_memory", "episodic_memory_agent_id");
    await queryInterface.removeColumn("episodic_memory", "agent_id");
  },
};
