"use strict";

/**
 * Refresh the catalog text for run_claude_cli after exposing Claude-specific
 * options in the LangChain tool schema.
 *
 * @type {import('sequelize-cli').Migration}
 */

const NEXT_DESCRIPTION =
  "Spawn a non-interactive Claude Code CLI session in a working directory and return its output. " +
  "Supports model selection, effort, max turns/budget, permission modes including plan mode, tool " +
  "allow/deny/restriction flags, additional directories, dynamic subagents, generated DB-backed MCP " +
  "config, and plan/review modes. Auto-resumes the most recent session in this thread by default. " +
  "Shares a host-wide lock with `run_codex_cli` — only one CLI subprocess can run at a time.";

const PREVIOUS_DESCRIPTION =
  "Spawn a non-interactive Claude Code CLI session in a working directory and return its output. " +
  "Auto-resumes the most recent session in this thread by default. Shares a host-wide lock with " +
  "`run_codex_cli` — only one CLI subprocess can run at a time.";

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE tools
       SET description = :description,
           updated_at = NOW()
       WHERE slug = 'run_claude_cli'`,
      { replacements: { description: NEXT_DESCRIPTION } },
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE tools
       SET description = :description,
           updated_at = NOW()
       WHERE slug = 'run_claude_cli'`,
      { replacements: { description: PREVIOUS_DESCRIPTION } },
    );
  },
};
