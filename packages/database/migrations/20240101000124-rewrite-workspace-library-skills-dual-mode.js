"use strict";

/**
 * Patches existing DB rows for the two locked filesystem-MCP-related
 * skills (`dev-in-house-workspace`, `dev-in-house-library-mcp`) so they
 * describe BOTH file-tool surfaces an agent might see at runtime:
 *
 *   - **A — Native SDK file tools** (`Read` / `Write` / `Edit` /
 *     `MultiEdit` / `Glob` / `Grep`, capitalised). Used by Anthropic
 *     SDK paths with built-ins enabled (primary agents with
 *     `allow_sdk_builtins=true`, deep-agent executors after the slice
 *     that switched them onto SDK built-ins).
 *   - **B — Filesystem MCP tools** (`read_text_file` / `write_file` /
 *     `edit_file` / `list_directory` / `search_files`, lowercase). Used
 *     by Codex SDK paths and by any path where the agent has filesystem
 *     MCP attached but SDK built-ins disabled.
 *
 * The skill text instructs the model to pick the right section by
 * inspecting its own tool list. This avoids needing to gate skill
 * assignment on runtime — the same skill text works for any agent with
 * `dev-in-house-workspace` / `dev-in-house-library-mcp` attached,
 * regardless of which SDK ends up executing the turn.
 *
 * The skill `slug`s are unchanged. The migration is a pure UPDATE: it
 * doesn't touch `agents_skills` assignments, `locked` state, or any
 * other column. If a row doesn't exist (rare — these are seeded in
 * migration 040 + 100), the INSERT IF NOT EXISTS guards installs them.
 *
 * @type {import('sequelize-cli').Migration}
 */

const WORKSPACE_SKILL = {
  slug: "dev-in-house-workspace",
  name: "Agent workspace",
  description:
    "Persistent per-agent scratch directory on disk. Accessed via SDK built-ins (Read/Write/Edit) on Anthropic SDK paths or filesystem MCP (read_text_file/write_file/edit_file) on filesystem-MCP paths.",
  skillText: `# Agent workspace

Your **persistent workspace** is a directory on disk that survives across conversations. The exact tools you use depend on which runtime is hosting this turn — inspect your tool list and follow the matching section below.

## Two possible file-tool surfaces

### A. Native SDK file tools (capitalised)
If your tool list shows \`Read\`, \`Write\`, \`Edit\`, \`MultiEdit\`, \`Glob\`, \`Grep\`, you are on the Claude Agent SDK with built-ins enabled. **Your current working directory IS your workspace root** — use bare or relative paths like \`notes.md\` or \`reports/q1.md\`. The SDK resolves them under cwd. A pre-write hook enforces the \`.md\`/\`.txt\` extension policy before disk; non-allowed extensions are rejected with a friendly error.

### B. Filesystem MCP tools (lowercase, snake_case)
If your tool list shows \`read_text_file\`, \`write_file\`, \`edit_file\`, \`list_directory\`, \`list_directory_with_sizes\`, \`directory_tree\`, \`search_files\`, \`create_directory\`, \`move_file\`, you are on the filesystem MCP path. The MCP server is rooted at \`/app/data\`. **Use absolute paths** prefixed by your \`WORKSPACE_PATH\` (announced in your system prompt) — never bare relative names on this path. The same \`.md\`/\`.txt\` extension gate applies.

> Pick A vs B by which tool names you actually see. Don't try to call the other surface's names; only one set is exposed per turn.

## What to store
Plans, notes, decision logs, investigation summaries, partial drafts, anything you want to re-read later. Prefer \`.md\` for structured notes and \`.txt\` for raw dumps. Do not dump entire tool outputs unless you actually need them again.

## Rules (apply on either surface)
1. **Read before edit.** Always read the target before editing — both \`Edit\` and \`edit_file\` match on exact text.
2. **Stay inside your workspace.** Do not write to other agents' workspace directories.
3. **One file per topic.** Do not append unrelated content to a single mega-file.
4. **Name files clearly.** \`project-X-plan.md\`, not \`notes2.md\`.
5. **No \`..\` traversal.** The hook/wrapper rejects paths that escape the workspace root.

## Executor / system-agent workflow (delegated runs)
When you were invoked via \`delegate_to_deep_agent\` (or similar), you do **not** have your own workspace — you act on the **caller's** workspace.

- On surface **A** (SDK), your cwd is set to the caller's workspace, so \`Read\`/\`Write\` resolve there directly. Use bare/relative paths (\`notes.md\`, \`threads/<id>/plan.md\`).
- On surface **B** (MCP), your prompt carries \`CALLER_WORKSPACE_PATH\` — use it as the absolute prefix.

1. Read the caller's recent workspace files first (\`Glob\` / \`list_directory\`) to understand prior context.
2. Write durable artifacts — plans, findings, reports — into the caller's workspace so they can pick them up.
3. **Self-report in your final response.** End your reply to the caller with a top-level section titled exactly \`## Workspace writes\` that lists every file you created, edited, or deleted (one bullet per file, path relative to the workspace root, with a one-line summary of why). If you made no workspace changes, write the section with a single bullet \`- (none)\`. The caller relies on this section to know what you touched.

## Not in this skill
- Org-shared reference documents (library) → \`dev-in-house-library-mcp\`.
- Free-form short notes that should always be in your system prompt → \`dev-in-house-agent-notes\`.
- Source code in product repositories → \`mcp-filesystem-repo\` (always filesystem MCP, different root paths).`,
};

const LIBRARY_MCP_SKILL = {
  slug: "dev-in-house-library-mcp",
  name: "Org library",
  description:
    "Admin-curated org-wide reference documents at /app/data/library. Read via the filesystem MCP when attached, or via SDK Read tools rooted at the library path when a library MCP / mounted route is provided.",
  skillText: `# Org library

Your organisation maintains a **shared library** of reference documents — playbooks, policies, onboarding notes, domain glossaries, uploaded by admins in the admin UI. Every agent in the org can **read** them; nothing in the library is per-agent.

## Where it lives
- On disk at \`/app/data/library\` — flat directory, original filenames.
- How you reach it depends on your runtime — see the two surfaces below.

## Two possible access surfaces

### A. Native SDK file tools (capitalised)
If your tool list shows \`Read\`, \`Glob\`, \`Grep\`, library access is only available when the admin has attached a library MCP server (or mounted the library at a known path) on this agent. Otherwise the \`/library\` surface is **not reachable on this path** for this turn — treat library content as unavailable and answer from your other context. Don't try to \`Read\` an absolute \`/app/data/library/...\` path; the SDK is sandboxed to your cwd.

### B. Filesystem MCP tools (lowercase, snake_case)
If your tool list shows \`read_text_file\`, \`list_directory\`, \`search_files\`, the library is reachable directly. Use \`list_directory\` on \`/app/data/library\` to browse, \`read_text_file\` for a specific file, \`search_files\` with \`path=/app/data/library\` to grep.

## When to consult it
Before answering a question that touches org-specific policies, procedures, or terminology — especially onboarding, support scripts, internal naming conventions, approved templates. The user may also point you at it explicitly ("there's a doc in the library about…").

## Rules
1. **Read-only.** You may never write, edit, move, or delete anything under \`/app/data/library\` (or whatever path the library is mounted at). That content is managed by admins from the UI.
2. **Flat namespace.** There are no subdirectories to walk — one listing call shows everything.
3. **Cite the filename** when you quote library content in your reply, so the user can verify.

## Not in this skill
- Your own persistent scratch → \`dev-in-house-workspace\`.
- Product source code → \`mcp-filesystem-repo\`.`,
};

/**
 * Same idempotent upsert as migration 100 — INSERT-if-missing then
 * UPDATE name/description/skill_text/locked. Safe to run on a DB where
 * the row was already replaced by 100 (this UPDATE just overwrites
 * with the new dual-mode text).
 */
async function upsertLockedSkill(queryInterface, { slug, name, description, skillText }) {
  await queryInterface.sequelize.query(
    `INSERT INTO skills (name, slug, description, skill_text, locked, created_at, updated_at)
     SELECT :name, :slug, :description, :skillText, true, NOW(), NOW()
     WHERE NOT EXISTS (SELECT 1 FROM skills WHERE slug = :slug)`,
    { replacements: { name, slug, description, skillText } },
  );
  await queryInterface.sequelize.query(
    `UPDATE skills
        SET name = :name,
            description = :description,
            skill_text = :skillText,
            locked = true,
            updated_at = NOW()
      WHERE slug = :slug`,
    { replacements: { name, slug, description, skillText } },
  );
}

module.exports = {
  async up(queryInterface) {
    await upsertLockedSkill(queryInterface, WORKSPACE_SKILL);
    await upsertLockedSkill(queryInterface, LIBRARY_MCP_SKILL);
  },

  async down(queryInterface) {
    // Down doesn't restore the prior single-surface text — that body is
    // recoverable from migration 100's history. Rolling back just leaves
    // the dual-mode rows in place, which is harmless: they describe both
    // surfaces, so any agent on either runtime still finds correct
    // guidance. No behaviour-affecting reverse needed.
    void queryInterface;
  },
};
