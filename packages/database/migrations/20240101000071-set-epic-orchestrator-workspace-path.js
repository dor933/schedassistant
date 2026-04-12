"use strict";

/** @type {import('sequelize-cli').Migration}
 *
 * The Epic Orchestrator agent was seeded via raw SQL (migration 0059)
 * which bypassed AgentsService.create() — the code path that sets
 * workspace_path and creates the filesystem folder. Fix it by setting
 * the column to match the convention used for all other agents:
 *   <DATA_DIR>/workspaces/<agent.definition>
 *
 * The actual directory is created lazily by the workspace tools on
 * first write, so only the DB column needs patching here.
 */
const AGENT_ID = "00000000-0000-4000-a000-000000000100";
const WORKSPACE_PATH = "/app/data/workspaces/Epic Task Orchestrator";

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE agents
         SET workspace_path = :workspacePath,
             updated_at = NOW()
       WHERE id = :agentId
         AND workspace_path IS NULL`,
      { replacements: { agentId: AGENT_ID, workspacePath: WORKSPACE_PATH } },
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE agents
         SET workspace_path = NULL,
             updated_at = NOW()
       WHERE id = :agentId`,
      { replacements: { agentId: AGENT_ID } },
    );
  },
};
