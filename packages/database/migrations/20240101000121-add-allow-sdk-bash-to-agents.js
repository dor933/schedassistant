"use strict";

/**
 * Adds `allow_sdk_bash` to `agents`.
 *
 * Separate per-agent flag for the SDK's built-in `Bash` tool, distinct from
 * `allow_sdk_builtins`. Reasoning:
 *   - `Bash` has a meaningfully larger blast radius than `Read`/`Write`/`Edit`
 *     (arbitrary shell, network, kill processes, …). Lumping it under the
 *     generic `allow_sdk_builtins` switch would force the same risk profile
 *     onto every agent that just needs file I/O.
 *   - Mirrors the granularity of the legacy `agent_available_tools` table,
 *     where `run_claude_cli` / `run_codex_cli` are separate slugs from the
 *     low-privilege defaults.
 *
 * Defaults to FALSE so existing agents keep their current surface. When TRUE,
 * `agentSdkRunner` adds `"Bash"` to `allowedTools` (and so does the
 * sub-agent definition builder for sub-agents that opt in).
 *
 * Once an agent is on `allow_sdk_bash=true`, it no longer needs the
 * `mcp-shell` MCP server attached via `agent_available_mcp_servers` — the
 * SDK's built-in Bash is more capable (persistent session, run_in_background,
 * structured exit code, KillShell companion).
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("agents", "allow_sdk_bash", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("agents", "allow_sdk_bash");
  },
};
