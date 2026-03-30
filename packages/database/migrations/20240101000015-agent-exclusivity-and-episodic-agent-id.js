"use strict";

/**
 * Agent group link + agent-level memory.
 *
 * 1. Add `group_id` to `agents` (nullable, UNIQUE) when the agent is dedicated to a group.
 *    Single-user chats are scoped only via `single_chats`, not a column on `agents`.
 * 2. Add `agent_id` to `episodic_memory` and `threads`.
 * 3. Backfill: clone DEFAULT agent per single_chat, link group agents, episodic `agent_id` from threads when set.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const DEFAULT_AGENT_ID = "00000000-0000-4000-a000-000000000001";

    await queryInterface.addColumn("agents", "group_id", {
      type: Sequelize.UUID,
      allowNull: true,
      unique: true,
      references: { model: "groups", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    });

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
      UPDATE agents a
      SET group_id = g.id
      FROM groups g
      WHERE g.agent_id = a.id
        AND a.group_id IS NULL
    `);

    // `threads` no longer have `single_chat_id` / `group_id`; `agent_id` is set at runtime
    // when sessions are created. Fresh DBs have no thread rows here.

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

    await queryInterface.removeColumn("agents", "group_id");
  },
};
