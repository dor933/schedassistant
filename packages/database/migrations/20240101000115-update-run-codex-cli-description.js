"use strict";

/**
 * Refresh the catalog text for run_codex_cli after exposing Codex-specific
 * options in the LangChain tool schema.
 *
 * @type {import('sequelize-cli').Migration}
 */

const NEXT_DESCRIPTION =
  "Spawn a non-interactive OpenAI Codex CLI session in a working directory and return its output. " +
  "Supports model selection, config profiles, reasoning effort, sandbox/approval policy, web search, " +
  "image inputs, plan/review modes, and prompt-driven subagents. Auto-resumes the most recent session " +
  "in this thread by default. Shares a host-wide lock with `run_claude_cli` — only one CLI subprocess " +
  "can run at a time.";

const PREVIOUS_DESCRIPTION =
  "Spawn a non-interactive OpenAI Codex CLI session in a working directory and return its output. " +
  "Auto-resumes the most recent session in this thread by default. Shares a host-wide lock with " +
  "`run_claude_cli` — only one CLI subprocess can run at a time.";

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE tools
       SET description = :description,
           updated_at = NOW()
       WHERE slug = 'run_codex_cli'`,
      { replacements: { description: NEXT_DESCRIPTION } },
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE tools
       SET description = :description,
           updated_at = NOW()
       WHERE slug = 'run_codex_cli'`,
      { replacements: { description: PREVIOUS_DESCRIPTION } },
    );
  },
};
