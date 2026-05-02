"use strict";

/**
 * Slice 11 — vendor-based skill split + always-on SDK built-ins.
 *
 * What this migration does
 * ------------------------
 * 1. **Splits the dual-mode workspace + library skills** (slice 10)
 *    into single-surface variants picked at runtime by vendor:
 *      - `dev-in-house-workspace-sdk`   — Surface A: SDK built-ins
 *        (`Read` / `Write` / `Edit` / `MultiEdit` / `Glob` / `Grep`).
 *        Auto-assigned to Anthropic-vendor agents.
 *      - `dev-in-house-workspace-mcp`   — Surface B: filesystem MCP
 *        (`read_text_file` / `write_file` / `edit_file` /
 *        `list_directory` / ...). Auto-assigned to non-Anthropic agents
 *        that have the filesystem MCP server attached.
 *      - `dev-in-house-library-sdk`     — Surface A library guidance.
 *        Auto-assigned to Anthropic agents (read-only — library access
 *        is only available when the executor has a library MCP).
 *      - `dev-in-house-library-mcp`     — Surface B library guidance
 *        (slug pre-existed; this migration trims its body to single
 *        surface).
 *
 *    The pre-existing slug `dev-in-house-workspace` (which migration
 *    100 + 124 turned into a dual-mode body) is RENAMED to
 *    `dev-in-house-workspace-mcp` and its body trimmed to single
 *    surface. The slug rename keeps any existing `agents_skills` rows
 *    referencing it valid (the join is by `skill_id`, not slug).
 *
 * 2. **Always-on SDK built-ins for Anthropic agents.**
 *    Migration 119 added `agents.allow_sdk_builtins BOOLEAN NOT NULL
 *    DEFAULT FALSE`. This migration:
 *      - sets `allow_sdk_builtins = true` on every agent whose model
 *        resolves to the Anthropic vendor, AND
 *      - flips the column default to TRUE.
 *
 *    The column stays in place as an override-down opt-out — admins
 *    can still toggle `false` for an unusual agent — but the typical
 *    case becomes "on by default" for Anthropic, matching the runner's
 *    new expectation.
 *
 * Idempotent: re-running is a no-op (INSERT IF NOT EXISTS, UPDATEs by
 * slug, conditional column-default change).
 *
 * @type {import('sequelize-cli').Migration}
 */

const WORKSPACE_SDK_SKILL = {
  slug: "dev-in-house-workspace-sdk",
  name: "Agent workspace (SDK built-ins)",
  description:
    "Persistent per-agent scratch directory accessed via the Claude Agent SDK's built-in file tools (Read / Write / Edit / MultiEdit / Glob / Grep). Auto-assigned to Anthropic-vendor agents.",
  skillText: `# Agent workspace — SDK built-ins

Your **persistent workspace** is a directory on disk that survives across conversations. You reach it through the Claude Agent SDK's built-in file tools — \`Read\`, \`Write\`, \`Edit\`, \`MultiEdit\`, \`Glob\`, \`Grep\` (capitalised).

## How paths resolve
**Your current working directory IS your workspace root.** Use bare or relative paths — \`notes.md\`, \`reports/q1.md\` — and the SDK resolves them under cwd. Don't use absolute host paths (\`/app/...\`, \`/home/...\`, \`/data/...\`); the SDK is sandboxed to your cwd and absolute paths outside it will be rejected.

## Extension policy
Writes are restricted to \`.md\` and \`.txt\` only. Any other extension (.json, .csv, .pdf, .xlsx, …) is rejected by a \`PreToolUse\` hook before the file touches disk. Render structured data as Markdown (tables, fenced code blocks, front-matter) inside a \`.md\` file when you need it.

## What to store
Plans, notes, decision logs, investigation summaries, partial drafts. Prefer \`.md\` for structured notes and \`.txt\` for raw dumps. Don't dump entire tool outputs unless you actually need them later.

## Rules
1. **Read before edit.** Always \`Read\` the target before \`Edit\`/\`MultiEdit\` — those tools match on exact text.
2. **Stay inside your workspace.** Don't traverse with \`..\`; the hook rejects escaping the workspace root.
3. **One file per topic.** Don't append unrelated content to a single mega-file.
4. **Name files clearly.** \`project-X-plan.md\`, not \`notes2.md\`.
5. **Orient first.** \`Glob "*"\` or \`Read\` something promising before you start — earlier specialists may have left context.

## Executor / system-agent workflow (delegated runs)
When you were invoked via \`delegate_to_deep_agent\`, you do **not** have your own workspace — your cwd is set to the **caller's** workspace. \`Read\`/\`Write\`/\`Edit\` resolve there directly. Use bare or relative paths.

1. Check the caller's recent files first (\`Glob "*"\` / \`Read\` anything relevant) to understand prior context.
2. Write durable artifacts (plans, findings, reports) into the caller's workspace so they can pick them up.
3. **Self-report in your final response.** End your reply with a top-level section titled exactly \`## Workspace writes\` listing every file you created, edited, or deleted (one bullet per file, path relative to the workspace root, with a one-line summary). If you made no workspace changes, write the section with a single bullet \`- (none)\`.

## Per-thread session folder
Your prompt may carry a per-thread folder name like \`threads/<id>/\`. Writes inside that folder are captured into the caller's session manifest, summarised when the thread closes, and indexed for vector retrieval. Writes elsewhere in the workspace are still saved but won't appear in the per-thread manifest.

## Not in this skill
- Org-shared reference documents (library) → \`dev-in-house-library-sdk\`.
- Free-form short notes that should always be in your system prompt → \`dev-in-house-agent-notes\`.
- Source code in product repositories → \`mcp-filesystem-repo\` (always filesystem MCP, different root paths).`,
};

const LIBRARY_SDK_SKILL = {
  slug: "dev-in-house-library-sdk",
  name: "Org library (SDK built-ins)",
  description:
    "Admin-curated org-wide reference documents. On the SDK path, library access is only available when a library MCP is attached separately — otherwise the surface is unreachable.",
  skillText: `# Org library — SDK path

Your organisation maintains a **shared library** of reference documents — playbooks, policies, onboarding notes, domain glossaries — uploaded by admins in the admin UI.

## Availability on this path
On the Claude Agent SDK path, library access is only available **when an admin has attached a library MCP server (or mounted the library at a known path)** to your agent. Otherwise the library surface is **not reachable** for this turn — treat library content as unavailable and answer from your other context.

To check: look for library-related MCP tools in your tool list (e.g. \`library_read\`, \`library_search\`, or similar). If none are present, the library is not reachable. Don't try to \`Read\` an absolute \`/app/data/library/...\` path — the SDK is sandboxed to your cwd and would reject it.

## When to consult it (when available)
Before answering a question that touches org-specific policies, procedures, or terminology — onboarding, support scripts, internal naming conventions, approved templates. The user may also point you at it explicitly ("there's a doc in the library about…").

## Rules
1. **Read-only.** Never write, edit, move, or delete library content. That directory is managed by admins from the UI.
2. **Cite the filename** when you quote library content in your reply, so the user can verify.

## Not in this skill
- Your own persistent scratch → \`dev-in-house-workspace-sdk\`.
- Product source code → \`mcp-filesystem-repo\`.`,
};

const WORKSPACE_MCP_SKILL = {
  slug: "dev-in-house-workspace-mcp",
  name: "Agent workspace (filesystem MCP)",
  description:
    "Persistent per-agent scratch directory accessed via the filesystem MCP server (read_text_file / write_file / edit_file / list_directory / search_files). Auto-assigned to non-Anthropic agents that have filesystem MCP attached.",
  skillText: `# Agent workspace — filesystem MCP

Your **persistent workspace** is a directory on disk that survives across conversations. You reach it through the **filesystem MCP** (server name: \`filesystem\`, rooted at \`/app/data\`) — tool names are lowercase, snake_case: \`read_text_file\`, \`write_file\`, \`edit_file\`, \`list_directory\`, \`list_directory_with_sizes\`, \`directory_tree\`, \`search_files\`, \`create_directory\`, \`move_file\`.

## Where the workspace lives
- Your workspace path is injected into your system prompt as \`WORKSPACE_PATH\`.
- It is an absolute path under \`/app/data\` — always use it as the prefix for workspace reads/writes.
- If you do not see a \`WORKSPACE_PATH\` in the prompt, you do not have a workspace (system/executor agents write into the *caller's* workspace — see below).

## Extension policy
Writes are restricted to \`.md\` and \`.txt\` only. Any other extension is rejected by the MCP wrapper before the file touches disk.

## What to store
Plans, notes, decision logs, investigation summaries, partial drafts. Prefer \`.md\` for structured notes and \`.txt\` for raw dumps.

## Rules
1. **Read before edit.** Always \`read_text_file\` the target before \`edit_file\` — the edit tool matches on exact text.
2. **Absolute paths only.** Use the \`WORKSPACE_PATH\` prefix; never bare relative paths on this surface.
3. **Stay inside your workspace.** Don't write to other agents' workspace directories.
4. **One file per topic.** Don't append unrelated content to a single mega-file.
5. **Name files clearly.** \`project-X-plan.md\`, not \`notes2.md\`.

## Executor / system-agent workflow (delegated runs)
When you were invoked via \`delegate_to_deep_agent\`, you do **not** have your own workspace — you act on the **caller's** workspace. The caller's workspace path is injected into your prompt as \`CALLER_WORKSPACE_PATH\`.

1. Read the caller's recent workspace files first (\`list_directory\` on \`CALLER_WORKSPACE_PATH\`) to understand prior context.
2. Write any durable artifacts — plans, findings, reports — into that same directory so the caller can pick them up.
3. **Self-report in your final response.** End your reply to the caller with a top-level section titled exactly \`## Workspace writes\` that lists every file you created, edited, or deleted (one bullet per file, relative to \`CALLER_WORKSPACE_PATH\`, with a one-line summary of why). If you made no workspace changes, write the section with a single bullet \`- (none)\`.

## Not in this skill
- Org-shared reference documents (library) → \`dev-in-house-library-mcp\`.
- Free-form short notes that should always be in your system prompt → \`dev-in-house-agent-notes\`.
- Source code in product repositories → \`mcp-filesystem-repo\` (same MCP, different root paths).`,
};

const LIBRARY_MCP_SKILL = {
  slug: "dev-in-house-library-mcp",
  name: "Org library (filesystem MCP)",
  description:
    "Admin-curated org-wide reference documents at /app/data/library, read via the filesystem MCP (read_text_file / list_directory / search_files).",
  skillText: `# Org library — filesystem MCP

Your organisation maintains a **shared library** of reference documents — playbooks, policies, onboarding notes, domain glossaries — uploaded by admins in the admin UI. Every agent in the org can **read** them; nothing in the library is per-agent.

## Where it lives
- Absolute path: \`/app/data/library\` — flat directory, original filenames.
- Access via the **filesystem MCP** (server name: \`filesystem\`): \`list_directory\` on \`/app/data/library\` to browse, \`read_text_file\` to read a specific file, \`search_files\` with \`path=/app/data/library\` to grep.

## When to consult it
Before answering a question that touches org-specific policies, procedures, or terminology — onboarding, support scripts, internal naming conventions, approved templates. The user may also point you at it explicitly ("there's a doc in the library about…").

## Rules
1. **Read-only.** You may never \`write_file\`, \`edit_file\`, \`move_file\`, or delete anything under \`/app/data/library\`. That directory is managed by admins from the UI.
2. **Flat namespace.** There are no subdirectories to walk — one \`list_directory\` call shows everything.
3. **Cite the filename** when you quote library content in your reply, so the user can verify.

## Not in this skill
- Your own persistent scratch → \`dev-in-house-workspace-mcp\`.
- Product source code → \`mcp-filesystem-repo\`.`,
};

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
  async up(queryInterface, Sequelize) {
    // 1. Rename the legacy `dev-in-house-workspace` row to the new
    //    `dev-in-house-workspace-mcp` slug. The skill_id stays the
    //    same so any agents_skills row referencing it remains valid.
    //    The body+description+name get fully replaced below by the
    //    upsertLockedSkill call. Done via a manual UPDATE here so the
    //    later upsert hits the renamed row instead of inserting a
    //    duplicate.
    await queryInterface.sequelize.query(
      `UPDATE skills
          SET slug = 'dev-in-house-workspace-mcp',
              updated_at = NOW()
        WHERE slug = 'dev-in-house-workspace'
          AND NOT EXISTS (SELECT 1 FROM skills WHERE slug = 'dev-in-house-workspace-mcp')`,
    );
    // If both rows somehow exist (shouldn't, but defensive), drop the
    // legacy row's any agents_skills references onto the new one and
    // delete the duplicate. (This branch is only hit if someone ran
    // a partial recovery.)
    await queryInterface.sequelize.query(
      `UPDATE agent_available_skills
          SET skill_id = (SELECT id FROM skills WHERE slug = 'dev-in-house-workspace-mcp')
        WHERE skill_id IN (SELECT id FROM skills WHERE slug = 'dev-in-house-workspace')`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM skills WHERE slug = 'dev-in-house-workspace'`,
    );

    // 2. Upsert all four single-surface skills with locked=true.
    await upsertLockedSkill(queryInterface, WORKSPACE_SDK_SKILL);
    await upsertLockedSkill(queryInterface, WORKSPACE_MCP_SKILL);
    await upsertLockedSkill(queryInterface, LIBRARY_SDK_SKILL);
    await upsertLockedSkill(queryInterface, LIBRARY_MCP_SKILL);

    // 3. Backfill `allow_sdk_builtins = true` on every agent whose
    //    resolved vendor is `anthropic`. Resolution path mirrors
    //    `resolveOrgVendor`: agents.model_id → models.vendor_id →
    //    vendors.slug. The `LLMModel` Sequelize model uses
    //    `tableName: "models"` (singular `models`, not `llm_models`)
    //    — see packages/database/src/models/LLMModel.ts. Idempotent:
    //    WHERE clause restricts to rows that aren't already true.
    await queryInterface.sequelize.query(
      `UPDATE agents
          SET allow_sdk_builtins = true,
              updated_at = NOW()
        WHERE allow_sdk_builtins = false
          AND model_id IN (
            SELECT m.id
              FROM models m
              JOIN vendors v ON v.id = m.vendor_id
             WHERE v.slug = 'anthropic'
          )`,
    );

    // 4. Flip the column default to TRUE so newly-created Anthropic
    //    agents inherit the on-by-default semantics. Non-Anthropic
    //    agents whose row default is true don't matter today (the
    //    runner only consults the flag inside `runAnthropicAgentSdk`),
    //    but if a future runtime ever does, the flag still works as
    //    an explicit opt-in/out per row.
    await queryInterface.changeColumn("agents", "allow_sdk_builtins", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });
  },

  async down(queryInterface, Sequelize) {
    // Re-flip the column default to FALSE.
    await queryInterface.changeColumn("agents", "allow_sdk_builtins", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    // We don't reset row values — those were set deliberately and
    // restoring `false` everywhere would silently break agents the
    // user has migrated to SDK builtins. The down here is a partial
    // rollback (column default only); skill rows stay split.

    // Skill rows: leave the new -sdk variants in place; restore the
    // pre-rename `dev-in-house-workspace` slug if the row exists
    // under the new name.
    await queryInterface.sequelize.query(
      `UPDATE skills
          SET slug = 'dev-in-house-workspace',
              updated_at = NOW()
        WHERE slug = 'dev-in-house-workspace-mcp'
          AND NOT EXISTS (SELECT 1 FROM skills WHERE slug = 'dev-in-house-workspace')`,
    );
  },
};
