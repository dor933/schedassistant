"use strict";

/**
 * Adds `claude_session_id` to `threads`.
 *
 * Used by the Claude Agent SDK runtime path to resume an existing Claude
 * session for the same conversation thread. Per the migration design
 * (`agentsSdkMigration.md` §6), this is a *secondary* identifier — the
 * LangGraph checkpoint remains the source of truth for application/workflow
 * state. The session id only enables Claude-side conversational continuity
 * across turns; if it ever expires or fails to resume, the runner falls back
 * to a fresh session and the system prompt continues to carry the rendered
 * context from the LangGraph checkpoint.
 *
 * The column is cleared after `sessionSummarizationNode` runs because
 * compaction breaks Claude-side continuity anyway — the next turn re-bootstraps
 * a session from the freshly-built system prompt + working summary.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("threads", "claude_session_id", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("threads", "claude_session_id");
  },
};
