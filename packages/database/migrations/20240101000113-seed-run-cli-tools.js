"use strict";

/**
 * Seeds the `run_claude_cli` and `run_codex_cli` tools — the per-agent
 * surface for the CLI execution engine in `utils/cliExecution.ts`.
 *
 * Intentionally NOT auto-assigned to every agent. Both tools spawn a real
 * CLI subprocess, count against API spend, and share the host-wide
 * concurrency lock (only one CLI at a time across all providers), so they
 * are treated as privileged capabilities. Admins grant them per-agent via
 * `agent_available_tools`.
 *
 * The Epic Orchestrator does NOT need these slugs — it calls
 * `runCliExecution(claudeAdapter, …)` directly from `executeTask` to skip
 * the LangChain tool indirection. These slugs are for any other agent
 * (specialists, deep agents, etc.) that wants ad-hoc CLI access.
 *
 * `kill_cli_execution` is a sibling capability — same admin-grantable
 * pattern as the run tools, surfaced separately so an admin can choose
 * whether a given agent is allowed to abort its own runs (typical) or
 * is read-only "spawn but never kill" (rare, but possible).
 *
 * @type {import('sequelize-cli').Migration}
 */

const TOOLS = [
  {
    name: "Run Claude CLI",
    slug: "run_claude_cli",
    category: "cli",
    description:
      "Spawn a non-interactive Claude Code CLI session in a working directory and return its output. " +
      "Supports model selection, effort, max turns/budget, permission modes including plan mode, tool " +
      "allow/deny/restriction flags, additional directories, dynamic subagents, generated DB-backed MCP " +
      "config, and plan/review modes. Auto-resumes the most recent session in this thread by default. " +
      "Shares a host-wide lock with `run_codex_cli` — only one CLI subprocess can run at a time.",
  },
  {
    name: "Run Codex CLI",
    slug: "run_codex_cli",
    category: "cli",
    description:
      "Spawn a non-interactive OpenAI Codex CLI session in a working directory and return its output. " +
      "Supports model selection, config profiles, reasoning effort, sandbox/approval policy, web search, " +
      "image inputs, plan/review modes, and prompt-driven subagents. Auto-resumes the most recent session " +
      "in this thread by default. Shares a host-wide lock with `run_claude_cli` — only one CLI subprocess " +
      "can run at a time.",
  },
  {
    name: "Kill CLI Execution",
    slug: "kill_cli_execution",
    category: "cli",
    description:
      "Abort an own-agent CLI subprocess (claude / codex) that was started via `run_*_cli` and is " +
      "still running — typically an orphan from a worker crash. Requires explicit user-approval quote. " +
      "Grant alongside `run_claude_cli` / `run_codex_cli` so the agent can recover from its own orphans.",
  },
];

module.exports = {
  async up(queryInterface, _Sequelize) {
    for (const tool of TOOLS) {
      await queryInterface.sequelize.query(
        `INSERT INTO tools (name, slug, description, category, created_at, updated_at)
         VALUES (:name, :slug, :description, :category, NOW(), NOW())
         ON CONFLICT (slug) DO NOTHING`,
        { replacements: tool },
      );
    }
  },

  async down(queryInterface, _Sequelize) {
    for (const tool of TOOLS) {
      await queryInterface.sequelize.query(
        `DELETE FROM agent_available_tools
         WHERE tool_id IN (SELECT id FROM tools WHERE slug = :slug)`,
        { replacements: { slug: tool.slug } },
      );
      await queryInterface.sequelize.query(
        `DELETE FROM tools WHERE slug = :slug`,
        { replacements: { slug: tool.slug } },
      );
    }
  },
};
