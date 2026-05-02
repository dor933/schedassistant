"use strict";

/**
 * Adds `codex_thread_id` to `threads`.
 *
 * Mirrors `claude_session_id` (migration 118) for the OpenAI Codex SDK
 * runtime path. Same semantics: a best-effort vendor-side session
 * pointer used to keep Codex's `~/.codex/sessions` thread warm across
 * consecutive turns. Cleared on summarization (the next turn
 * re-bootstraps a fresh thread because compaction has rewritten the
 * rendered context). LangGraph checkpoints remain the authoritative
 * source for conversation state — this column only enables
 * vendor-internal continuity.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("threads", "codex_thread_id", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("threads", "codex_thread_id");
  },
};
