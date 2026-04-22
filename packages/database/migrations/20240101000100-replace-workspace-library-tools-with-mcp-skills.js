"use strict";

/**
 * Replaces the `workspaceTools`/`libraryTools` in-house tool families with
 * skill-driven guidance that leans on the filesystem MCP server. Two skills
 * are written:
 *
 *  - `dev-in-house-workspace` — rewritten body + description: the agent's
 *    persistent workspace is now a directory under `/app/data/agent-workspaces`
 *    accessed via the filesystem MCP (`read_text_file` / `write_file` /
 *    `edit_file` / `list_directory` / `search_files`). Includes the
 *    Workspace-writes self-report requirement for executor/system agents so
 *    the caller still learns what changed after delegation.
 *
 *  - `dev-in-house-library-mcp` — newly inserted: reads the admin-curated
 *    org library at `/app/data/library` via the same filesystem MCP.
 *
 * Both skills are marked `locked = true` so the admin UI cannot edit them
 * (they are auto-assigned to every agent that has the filesystem MCP
 * attached; see `FILESYSTEM_MCP_SKILL_SLUGS` in packages/types).
 *
 * @type {import('sequelize-cli').Migration}
 */

const WORKSPACE_SKILL = {
  slug: "dev-in-house-workspace",
  name: "Agent workspace (filesystem MCP)",
  description:
    "Persistent per-agent scratch directory on disk, accessed via the filesystem MCP. Use for plans, notes, summaries, and any work you want to keep across turns.",
  skillText: `# Agent workspace

Your **persistent workspace** is a directory on disk that survives across conversations. It is accessed through the **filesystem MCP** (server name: \`filesystem\`, rooted at \`/app/data\`) — the same tools you use for any file work: \`read_text_file\`, \`write_file\`, \`edit_file\`, \`list_directory\`, \`list_directory_with_sizes\`, \`directory_tree\`, \`search_files\`, \`create_directory\`, \`move_file\`.

## Where the workspace lives
- Your workspace path is injected into your system prompt as \`WORKSPACE_PATH\`.
- It is an absolute path under \`/app/data\` — always use it as the prefix for workspace reads/writes.
- If you do not see a \`WORKSPACE_PATH\` in the prompt, you do not have a workspace (system/executor agents write into the *caller's* workspace — see below).

## What to store
Plans, notes, decision logs, investigation summaries, partial drafts, anything you want to re-read later. Prefer \`.md\` for structured notes and \`.txt\` for raw dumps. Do not dump entire tool outputs unless you actually need them again.

## Rules
1. **Read before edit.** Always \`read_text_file\` the target before \`edit_file\` — the edit tool matches on exact text.
2. **Absolute paths only.** Use the \`WORKSPACE_PATH\` prefix; never relative paths.
3. **Stay inside your workspace.** Do not write to other agents' workspace directories.
4. **One file per topic.** Do not append unrelated content to a single mega-file.
5. **Name files clearly.** \`project-X-plan.md\`, not \`notes2.md\`.

## Executor / system-agent workflow (delegated runs)
When you were invoked via \`delegate_to_deep_agent\` (or similar), you do **not** have your own workspace — you act on the **caller's** workspace. The caller's workspace path is injected into your prompt as \`CALLER_WORKSPACE_PATH\`.

1. Read the caller's recent workspace files first (\`list_directory\` on \`CALLER_WORKSPACE_PATH\`) to understand prior context.
2. Write any durable artifacts — plans, findings, reports — into that same directory so the caller can pick them up.
3. **Self-report in your final response.** End your reply to the caller with a top-level section titled exactly \`## Workspace writes\` that lists every file you created, edited, or deleted (one bullet per file, relative to \`CALLER_WORKSPACE_PATH\`, with a one-line summary of why). If you made no workspace changes, write the section with a single bullet \`- (none)\`. The caller relies on this section to know what you touched.

## Not in this skill
- Org-shared reference documents (library) → \`dev-in-house-library-mcp\`.
- Free-form short notes that should always be in your system prompt → \`dev-in-house-agent-notes\`.
- Source code in product repositories → \`mcp-filesystem-repo\` (same MCP, different root paths).`,
};

const LIBRARY_MCP_SKILL = {
  slug: "dev-in-house-library-mcp",
  name: "Org library (filesystem MCP)",
  description:
    "Admin-curated org-wide reference documents at /app/data/library, read via the filesystem MCP.",
  skillText: `# Org library

Your organisation maintains a **shared library** of reference documents — playbooks, policies, onboarding notes, domain glossaries, uploaded by admins in the admin UI. Every agent in the org can **read** them; nothing in the library is per-agent.

## Where it lives
- Absolute path: \`/app/data/library\` — flat directory, original filenames.
- Access via the **filesystem MCP** (server name: \`filesystem\`): \`list_directory\` \`/app/data/library\` to browse, \`read_text_file\` to read a specific file.

## When to consult it
Before answering a question that touches org-specific policies, procedures, or terminology — especially onboarding, support scripts, internal naming conventions, approved templates. The user may also point you at it explicitly ("there's a doc in the library about…").

## Rules
1. **Read-only.** You may never \`write_file\`, \`edit_file\`, \`move_file\`, or delete anything under \`/app/data/library\`. That directory is managed by admins from the UI.
2. **Flat namespace.** There are no subdirectories to walk — one \`list_directory\` call shows everything.
3. **Cite the filename** when you quote library content in your reply, so the user can verify.

## Not in this skill
- Your own persistent scratch → \`dev-in-house-workspace\`.
- Product source code → \`mcp-filesystem-repo\`.`,
};

async function upsertLockedSkill(queryInterface, { slug, name, description, skillText }) {
  // 1. Insert if missing.
  await queryInterface.sequelize.query(
    `INSERT INTO skills (name, slug, description, skill_text, locked, created_at, updated_at)
     SELECT :name, :slug, :description, :skillText, true, NOW(), NOW()
     WHERE NOT EXISTS (SELECT 1 FROM skills WHERE slug = :slug)`,
    { replacements: { name, slug, description, skillText } },
  );
  // 2. Update body, name, description, lock state — even if row pre-existed.
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
    // We don't restore the old workspace-tools copy — the tools it described
    // no longer exist in code. Removing only the newly-inserted library skill
    // is the safe rollback; the workspace skill row stays with whatever body
    // this migration installed.
    await queryInterface.sequelize.query(
      `DELETE FROM skills WHERE slug = :slug`,
      { replacements: { slug: LIBRARY_MCP_SKILL.slug } },
    );
  },
};
