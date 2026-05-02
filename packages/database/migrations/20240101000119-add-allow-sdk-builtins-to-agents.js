"use strict";

/**
 * Adds `allow_sdk_builtins` to `agents`.
 *
 * Per-agent opt-in for the Claude Agent SDK's built-in I/O tools (Read,
 * Write, Edit, MultiEdit, Glob, Grep, WebFetch). Defaults to FALSE so
 * existing agents keep their current behavior — the model continues to use
 * the filesystem MCP / explicit MCP tools rather than the SDK built-ins
 * until an admin flips the flag for a specific agent.
 *
 * Why opt-in:
 *   - Built-in Write/Edit go through PreToolUse / PostToolUse hooks for the
 *     `.md`/`.txt` extension gate and session-file ledger capture, but
 *     turning them on changes the tool surface the model sees and may
 *     change its behavior compared to "MCP-only" today. Per-agent rollout
 *     lets us validate one agent at a time before flipping defaults.
 *   - Read-only built-ins (Read, Glob, Grep) carry no instrumentation
 *     concern but are still gated by this flag for symmetry — flipping
 *     the flag enables the full built-in suite for the agent.
 *
 * Applies to BOTH primary agents (the SDK call's top-level capabilities)
 * AND system agents acting as SDK sub-agents (their `AgentDefinition.tools`
 * list).
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("agents", "allow_sdk_builtins", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("agents", "allow_sdk_builtins");
  },
};
