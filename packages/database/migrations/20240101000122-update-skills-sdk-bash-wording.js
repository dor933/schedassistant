"use strict";

/**
 * Backfills `skill_text` for environments that ran migrations 040 / 041 / 049 /
 * 062 BEFORE the source files were updated to reference the Claude Agent SDK's
 * native `Bash` tool. New installs get the corrected wording directly from
 * those source migrations; this migration only patches in-place rows so live
 * databases match.
 *
 * The transformation is purely string-substitution on each affected skill
 * row's `skill_text`. We do NOT rewrite each skill from scratch because
 * admins / users may have edited them in-place and we don't want to clobber
 * those edits.
 *
 * Why string REPLACE rather than full rewrite:
 *   - Skills are user-editable from the admin UI. A full rewrite would
 *     overwrite hand-tuned guidance.
 *   - REPLACE on a string that's not present is a no-op, so this is safe
 *     to re-run and safe in environments where the skill_text has drifted.
 *
 * No structural / DB-row changes happen here:
 *   - `mcp_servers` row `name='bash'` is intentionally NOT removed — admins
 *     deactivate it per-agent in the admin UI as agents are migrated to
 *     `agents.allow_sdk_bash=true`.
 *   - `agent_available_mcp_servers` linkages: same.
 *
 * @type {import('sequelize-cli').Migration}
 */

/**
 * Pairs of `[before, after]` substrings to apply to every skill_text row.
 * Order matters: longer / more specific phrases come first so they consume
 * the broader phrase before the broader replacement runs.
 */
const REPLACEMENTS = [
  // Full skill headers / file-name mentions ──────────────────────────────
  ["# Docker — bash MCP (`mcp-shell`)", "# Docker — SDK `Bash` tool"],
  ["# HTTP requests — bash MCP (`mcp-shell`)", "# HTTP requests — SDK `Bash` tool"],
  ["# Build & test — bash MCP", "# Build & test — SDK `Bash` tool"],

  // Server-callout sections ─────────────────────────────────────────────
  [
    "## Server\n- **bash** (DB name) — `npx -y mcp-shell`",
    "## Tool\n- **`Bash`** — built into the Claude Agent SDK. Requires\n  `agents.allow_sdk_bash=true` for this agent. Persistent shell session,\n  `run_in_background` for long-running commands.",
  ],
  [
    "## Server\n- **bash** (`mcp-shell`)",
    "## Tool\n- **`Bash`** — built into the Claude Agent SDK. Requires\n  `agents.allow_sdk_bash=true` for this agent.",
  ],

  // Inline references in `gh-cli` and `mcp-filesystem-repo` ─────────────
  [
    "Use them through the **bash MCP** (`mcp-shell`) — run commands like any other shell command.",
    "Use them through the **Bash** tool (built into the Claude Agent SDK; requires\n`agents.allow_sdk_bash=true` for this agent) — run commands like any other\nshell command.",
  ],
  [
    "For running commands, use the **bash** MCP skills (`gh-cli`, `mcp-bash-build-test`).",
    "For running commands, use the SDK `Bash` tool (skills: `gh-cli`, `mcp-bash-build-test`).",
  ],
  [
    "| Run `git clone`, `git commit`, `git push` | `gh-cli` (bash MCP) |",
    "| Run `git clone`, `git commit`, `git push` | `gh-cli` (SDK Bash) |",
  ],
  [
    "| Run `npm install`, `pytest`, `make build` | `mcp-bash-build-test` (bash MCP) |",
    "| Run `npm install`, `pytest`, `make build` | `mcp-bash-build-test` (SDK Bash) |",
  ],
  [
    "| Run any shell command | bash MCP skills |",
    "| Run any shell command | SDK `Bash` tool (any bash skill) |",
  ],

  // Epic-task-workflow tool table — `run_command` row, both pre- and
  // post-migration-062 forms ───────────────────────────────────────────
  [
    "| `run_command` | Run shell commands (git, gh) via the **bash MCP** — use for pushing branches and creating PRs |",
    "| `run_command` | Run shell commands (git, gh) via the SDK `Bash` tool — use for pushing branches and creating PRs |",
  ],
  [
    "| `run_command` | Run shell commands (git, gh) via the **bash MCP** — for general shell operations |",
    "| `run_command` | Run shell commands (git, gh) via the SDK `Bash` tool — for general shell operations |",
  ],
];

/**
 * Reverse mapping for `down`. Restores the original "bash MCP" wording so
 * a rollback puts the DB back into the state migration 121 expected.
 */
const REVERSE_REPLACEMENTS = REPLACEMENTS.map(([from, to]) => [to, from]);

async function applyReplacements(queryInterface, pairs) {
  // One UPDATE per pair, scoped by a LIKE filter so we only touch rows
  // that actually contain the source string. Pure SQL — no in-app loop —
  // so we don't materialize every skill row in Node.
  for (const [from, to] of pairs) {
    await queryInterface.sequelize.query(
      `UPDATE skills
         SET skill_text = REPLACE(skill_text, :from, :to),
             updated_at = NOW()
       WHERE skill_text LIKE :likePattern`,
      {
        replacements: {
          from,
          to,
          // PostgreSQL LIKE wildcards in the source string would be
          // interpreted as patterns. Source strings here are plain text,
          // but we still escape `%` and `_` defensively.
          likePattern: `%${from.replace(/[%_]/g, "\\$&")}%`,
        },
      },
    );
  }

  // Skill names / descriptions also gained "(bash MCP)" / "bash MCP shell"
  // suffixes in migrations 40 / 41. Rename to "(SDK Bash)" / "SDK Bash tool"
  // so the admin UI listing matches the body content.
  const NAME_DESC_PAIRS = [
    ["Build, test, lint (bash MCP)", "Build, test, lint (SDK Bash)"],
    ["Docker CLI (bash MCP)", "Docker CLI (SDK Bash)"],
    ["HTTP requests (bash MCP)", "HTTP requests (SDK Bash)"],
    [
      "Manage Docker containers, images, volumes, and networks via the bash MCP shell.",
      "Manage Docker containers, images, volumes, and networks via the SDK Bash tool.",
    ],
    [
      "Perform HTTP requests (GET, POST, PUT, DELETE) via curl in the bash MCP shell.",
      "Perform HTTP requests (GET, POST, PUT, DELETE) via curl in the SDK Bash tool.",
    ],
    [
      "Run package managers, test runners, linters, typecheck via bash MCP.",
      "Run package managers, test runners, linters, typecheck via the SDK Bash tool.",
    ],
    [
      "All git operations (clone, commit, push, branch, merge) and GitHub operations (PRs, issues, checks) via git and gh CLI through bash MCP.",
      "All git operations (clone, commit, push, branch, merge) and GitHub operations (PRs, issues, checks) via git and gh CLI through the SDK Bash tool.",
    ],
  ];
  for (const [from, to] of NAME_DESC_PAIRS) {
    await queryInterface.sequelize.query(
      `UPDATE skills
         SET name = REPLACE(name, :from, :to),
             description = REPLACE(description, :from, :to),
             updated_at = NOW()
       WHERE name LIKE :likePattern OR description LIKE :likePattern`,
      {
        replacements: {
          from,
          to,
          likePattern: `%${from.replace(/[%_]/g, "\\$&")}%`,
        },
      },
    );
  }
}

module.exports = {
  async up(queryInterface) {
    await applyReplacements(queryInterface, REPLACEMENTS);
  },

  async down(queryInterface) {
    await applyReplacements(queryInterface, REVERSE_REPLACEMENTS);
  },
};
