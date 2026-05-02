"use strict";

/**
 * Slice 21 — retires the `run_claude_cli`, `run_codex_cli`, and
 * `kill_cli_execution` tools.
 *
 * These were configurable per-agent capabilities introduced when the
 * primary chat-completion path used LangChain's ChatAnthropic /
 * ChatOpenAI objects. Spawning a CLI subprocess was the only way to
 * give an agent a fully-tooled "go modify a repo" surface back then.
 *
 * Now the runtime is the Anthropic Agent SDK / Codex SDK in-process
 * with native file tools (Read/Write/Edit/Glob/Grep/Bash for Anthropic;
 * `apply_patch` etc. for Codex). The CLI subprocess wrapper added
 * latency, a host-wide concurrency lock, and a credential-handoff hop
 * with no remaining benefit. Slice 20 already replaced the epic
 * orchestrator's CLI flow with sub-agent dispatch; this migration
 * removes the leftover per-agent CLI tools.
 *
 * Order matters:
 *   1. Drop the `agent_available_tools` rows that reference these slugs
 *      so the FK delete on `tools` succeeds without violating constraints.
 *   2. Drop the `tools` rows.
 *
 * The `cli_executions` audit table is intentionally NOT dropped here —
 * historical execution records remain useful for billing audits and
 * post-mortem investigation. A separate migration can drop it later
 * once we're confident no internal tooling reads from it.
 *
 * @type {import('sequelize-cli').Migration}
 */

const SLUGS = ["run_claude_cli", "run_codex_cli", "kill_cli_execution"];

module.exports = {
  async up(queryInterface, _Sequelize) {
    // 1. Cascade-clear the per-agent grants. We use IN with a sub-select
    //    so the cleanup is atomic even when a slug exists with multiple
    //    historical id values (catalog re-seeds, dev environments).
    //
    // Note: `IN (:slugs)` rather than `= ANY(:slugs)` — Sequelize's
    // `replacements` substitutes a JS array as comma-separated bound
    // values (which `IN (...)` accepts) rather than wrapping them in a
    // Postgres `ARRAY[...]` literal (which `ANY(...)` requires).
    await queryInterface.sequelize.query(
      `DELETE FROM agent_available_tools
        WHERE tool_id IN (
          SELECT id FROM tools WHERE slug IN (:slugs)
        )`,
      { replacements: { slugs: SLUGS } },
    );

    // 2. Drop the catalog rows themselves.
    await queryInterface.sequelize.query(
      `DELETE FROM tools WHERE slug IN (:slugs)`,
      { replacements: { slugs: SLUGS } },
    );
  },

  async down(_queryInterface, _Sequelize) {
    // No-op. Migration 113 (seed-run-cli-tools) and 116 / 115 (descriptions)
    // are the historical seeders for these rows; rerunning them would
    // require resurrecting the deleted source files (`runCliTools.ts`,
    // `killCliExecutionTool.ts`). If you need to revert this slice,
    // restore those files and run the legacy seed migrations manually.
  },
};
