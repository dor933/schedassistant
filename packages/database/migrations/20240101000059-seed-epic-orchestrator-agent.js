"use strict";

/**
 * Seeds the singleton Epic Orchestrator agent.
 *
 * - Identified by fixed UUID (no agent_type column needed)
 * - Cannot be added to groups (enforced in app layer)
 * - Appears as a SingleChat for every user (via ensureAgentSingleChats on login)
 * - Has the "epic-task-workflow" skill auto-linked
 *
 * All operations are idempotent (safe to re-run).
 *
 * @type {import('sequelize-cli').Migration}
 */

const AGENT_ID = "00000000-0000-4000-a000-000000000100";

module.exports = {
  async up(queryInterface) {
    const now = new Date();

    // 0. Ensure agents_skills junction table exists (IF NOT EXISTS — no-op if already there)
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS agents_skills (
        id SERIAL PRIMARY KEY,
        agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    // 1. Create the agent (only if it doesn't already exist)
    await queryInterface.sequelize.query(
      `INSERT INTO agents (id, definition, agent_name, core_instructions, created_at, updated_at)
       SELECT :id, :definition, :agentName, :coreInstructions, :now, :now
       WHERE NOT EXISTS (SELECT 1 FROM agents WHERE id = :id)`,
      {
        replacements: {
          id: AGENT_ID,
          definition: "Epic Task Orchestrator",
          agentName: "Epic Orchestrator",
          coreInstructions:
            "You are the Epic Task Orchestrator — a specialized Project Manager agent. " +
            "Your job is to plan and execute multi-step coding tasks (epics) across locally cloned repositories. " +
            "Always load your Epic Task Workflow skill before starting work. " +
            "Follow the skill procedure exactly: clarify scope, plan the epic, execute tasks one at a time via Claude CLI, " +
            "review git diffs after each execution, and report progress to the user.",
          now,
        },
      },
    );

    // 2. Link the epic-task-workflow skill to this agent (only if not already linked)
    await queryInterface.sequelize.query(
      `INSERT INTO agents_skills (agent_id, skill_id, created_at)
       SELECT :agentId, s.id, :now
       FROM skills s
       WHERE s.slug = 'epic-task-workflow'
         AND NOT EXISTS (
           SELECT 1 FROM agents_skills
           WHERE agent_id = :agentId AND skill_id = s.id
         )`,
      {
        replacements: {
          agentId: AGENT_ID,
          now,
        },
      },
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DELETE FROM agents_skills WHERE agent_id = :id`,
      { replacements: { id: AGENT_ID } },
    ).catch(() => {});

    await queryInterface.sequelize.query(
      `DELETE FROM single_chats WHERE agent_id = :id`,
      { replacements: { id: AGENT_ID } },
    ).catch(() => {});

    await queryInterface.sequelize.query(
      `DELETE FROM agents WHERE id = :id`,
      { replacements: { id: AGENT_ID } },
    );
  },
};
