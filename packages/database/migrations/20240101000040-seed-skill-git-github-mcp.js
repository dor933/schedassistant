"use strict";

/**
 * Seeds one Skill row per slug — assign skills to agents independently via the UI (`agents_skills`).
 * Idempotent: INSERT … WHERE NOT EXISTS on `slug`.
 *
 * MCP servers referenced: bash, fetch, github, docker, massive_market_data (see `mcp_servers` seed).
 *
 * @type {import('sequelize-cli').Migration}
 */

/** @type {{ slug: string; name: string; description: string; skillText: string; systemAgentAssignable?: boolean }[]} */
const SKILLS = [
  // ─── MCP: git / GitHub / bash (split so agents can take git without GitHub API, etc.) ───
  {
    slug: "mcp-git-cli-bash",
    name: "Git CLI (bash MCP)",
    description: "Run git via bash/mcp-shell: clone, pull, push, branch, merge. Uses GIT_SSH_COMMAND when set.",
    skillText: `
    # Git CLI — bash MCP (\`mcp-shell\`)

## Server
- **bash** (DB name) — \`npx -y mcp-shell\`

## Scope
Local **git** only: \`clone\`, \`status\`, \`diff\`, \`log\`, \`branch\`, \`commit\`, \`pull\`, \`push\`, \`merge\`, \`rebase\`, \`remote\`, \`fetch\`, \`config\`, etc.

## Authentication — HTTPS + PAT (primary method)

> **SSH is NOT available** in this container (\`ssh\` client is not installed).
> Do **not** attempt \`git@github.com:…\` URLs — they will fail with \`ssh: not found\`.

### Clone / Fetch / Push — use HTTPS with the GitHub PAT:

\`\`\`bash
git clone https://x-access-token:\${GITHUB_PERSONAL_ACCESS_TOKEN}@github.com/OWNER/REPO.git /tmp/REPO 2>&1
\`\`\`

### Fallback order (do NOT waste turns on methods that fail):
1. ✅ **HTTPS + PAT** — \`https://x-access-token:\${GITHUB_PERSONAL_ACCESS_TOKEN}@github.com/OWNER/REPO.git\` — **USE THIS FIRST**
2. ❌ **SSH** — \`git@github.com:OWNER/REPO.git\` — **BROKEN** (no \`ssh\` binary in container)
3. ❌ **Plain HTTPS** — \`https://github.com/OWNER/REPO.git\` — **BROKEN** (no interactive credentials)

### Setting credentials for an already-cloned repo:
\`\`\`bash
cd /tmp/REPO && git remote set-url origin https://x-access-token:\${GITHUB_PERSONAL_ACCESS_TOKEN}@github.com/OWNER/REPO.git
\`\`\`

## Rules
1. Only claim success after **real** tool output.
2. \`cd\` to the repo root in the same shell command when needed.
3. Report stderr honestly.
4. **Always start with HTTPS + PAT method** — do not try SSH or plain HTTPS.

## Not in this skill
- **GitHub REST** (API fork, issues, PRs via API) → \`mcp-github-api\` (PAT applies there too).
- **Reading/editing files** without git → \`mcp-filesystem-repo\`.
- **Tests/builds** → \`mcp-bash-build-test\`.

    `,
  },
  {
    slug: "mcp-github-api",
    name: "GitHub API (github MCP)",
    description: "GitHub REST via @modelcontextprotocol/server-github; GITHUB_PERSONAL_ACCESS_TOKEN in MCP env.",
    skillText: `# GitHub API — github MCP

## Server
- **github** — \`npx -y @modelcontextprotocol/server-github\`

## Scope
**GitHub.com HTTP API** only (what this MCP exposes): issues, PRs, **fork via API**, repo metadata, search, labels, etc.

## PAT vs SSH (important)
- **GITHUB_PERSONAL_ACCESS_TOKEN** is for **REST API** calls only. It is **not** used for \`git clone\`/\`push\` over SSH — use **\`mcp-git-cli-bash\`** with \`git@github.com:...\` and the container’s **GIT_SSH_COMMAND** / deploy key instead.
- **Fork** is an **API** action. If you get **Permission denied** / insufficient scope, the token lacks rights (e.g. classic PAT: \`repo\` / \`public_repo\` as appropriate; fine-grained: repository access + contents). **An SSH key cannot perform API fork** — either fix the token scopes or fork in the browser and then \`git clone\` via SSH.

## Environment
- **GITHUB_PERSONAL_ACCESS_TOKEN** is merged into MCP env. Never print it.

## Not in this skill
- Local \`git\` over SSH → \`mcp-git-cli-bash\`.
- Arbitrary non-GitHub HTTP URLs → \`dev-fetch-mcp\`.`,
  },
  {
    slug: "mcp-filesystem-repo",
    name: "File editing & management (filesystem MCP)",
    description: "Read, write, edit, create, delete, move, and search project files under /app/data. This is required inter alia for coding — writing and modifying source code.",
    skillText: `# File editing & management — filesystem MCP

> **This is your coding skill.** Whenever you need to read source code, write new files,
> edit existing files, create directories, or move/rename files — use this skill.
>
> **This is NOT a shell.** You cannot run commands (\`npm\`, \`git\`, \`pytest\`, \`curl\`, etc.) through this skill.
> For running commands, use the **bash** MCP skills (\`mcp-git-cli-bash\`, \`mcp-bash-build-test\`).

## Server
- **filesystem** (DB name) — \`npx -y @modelcontextprotocol/server-filesystem /app/data\`

## When to use this skill
- **Reading** source code, config files, READMEs, logs on disk
- **Writing** new source files, configs, scripts
- **Editing** existing code (bug fixes, feature additions, refactors)
- **Searching** for files by name or pattern in the repo tree
- **Browsing** directory structure to understand project layout
- **Moving / renaming** files or folders
- **Deleting** files or folders

## When NOT to use this skill
| Need | Use instead |
|------|-------------|
| Run \`git clone\`, \`git commit\`, \`git push\` | \`mcp-git-cli-bash\` (bash MCP) |
| Run \`npm install\`, \`pytest\`, \`make build\` | \`mcp-bash-build-test\` (bash MCP) |
| Run any shell command | bash MCP skills |

## Available tools

### Reading
- **\`read_text_file\`** — read a file as UTF-8 text
- **\`read_media_file\`** — read images/audio as base64
- **\`read_multiple_files\`** — read several files at once (fewer round-trips)
- **\`list_directory\`** — list folder contents with type indicators
- **\`list_directory_with_sizes\`** — list with file sizes
- **\`directory_tree\`** — recursive JSON tree of contents
- **\`search_files\`** — recursively find files matching a pattern
- **\`get_file_info\`** — metadata (size, timestamps, permissions)
- **\`list_allowed_directories\`** — see which directories are accessible

### Writing & editing
- **\`write_file\`** — create a new file or overwrite an existing one
- **\`edit_file\`** — targeted edits using pattern matching (best for surgical code changes)
- **\`create_directory\`** — create new directories
- **\`move_file\`** — rename or relocate files and folders

## Practices
- Use **absolute paths** under \`/app/data/...\`.
- **Read before editing** — always read the current file content before making changes.
- Use \`read_multiple_files\` when you need context from several files.
- Use \`search_files\` to locate files before reading blindly.
- Use \`edit_file\` for small, targeted changes; use \`write_file\` for full rewrites or new files.
- Never invent file contents; always base edits on what you actually read.`,
  },
  {
    slug: "mcp-bash-build-test",
    name: "Build, test, lint (bash MCP)",
    description: "Run package managers, test runners, linters, typecheck via bash MCP.",
    skillText: `# Build & test — bash MCP

## Server
- **bash** (\`mcp-shell\`)

## Scope
**Tooling**: \`npm\`/\`pnpm\`/\`yarn\`, \`pytest\`, \`jest\`, \`cargo test\`, \`go test\`, formatters, linters, typecheckers — run the **narrowest** command first when iterating.

## Practices
- Summarize **actual** stdout/stderr and exit behavior from tools.
- Do not claim green tests without evidence.

## Not in this skill
- **Git** operations → \`mcp-git-cli-bash\`.
- **Editing source** for review without running suite → \`mcp-filesystem-repo\`.`,
  },



  // ─── In-house: collaboration (split peer vs deep) — chat agents only ───
  {
    slug: "dev-in-house-peer-agents",
    systemAgentAssignable: false,
    name: "Peer agents (consult_agent)",
    description: "list_agents + consult_agent — synchronous help from another chat agent.",
    skillText: `# Peer agents

| Step | Tool |
|------|------|
| Find peers | \`list_agents\` |
| Ask | \`consult_agent\` (\`targetAgentId\`, \`request\`) |

Sync answer in-thread. Do not use \`list_system_agents\` for peers.

## Related
- Background specialists → \`dev-in-house-deep-agents\`.`,
  },
  {
    slug: "dev-in-house-deep-agents",
    systemAgentAssignable: false,
    name: "Deep agents (delegate_to_deep_agent)",
    description: "list_system_agents + delegate_to_deep_agent — async long-running specialists.",
    skillText: `# Deep / system agents

| Step | Tool |
|------|------|
| List | \`list_system_agents\` |
| Delegate | \`delegate_to_deep_agent\` (\`systemAgentSlug\`, \`request\`) |

**Async** — you do not get the result immediately.

## Related
- Peer chat → \`dev-in-house-peer-agents\`.`,
  },

  // ─── In-house: tracking & notes (split) — chat agents only ───
  {
    slug: "dev-in-house-ongoing-requests",
    systemAgentAssignable: false,
    name: "Ongoing requests",
    description: "add_ongoing_request / remove_ongoing_request.",
    skillText: `# Ongoing requests

- **\`add_ongoing_request\`** — track multi-turn follow-ups (shown in system prompt).
- **\`remove_ongoing_request\`** — use \`request_id\` from the prompt when done.

## Related
- Agent notes → \`dev-in-house-agent-notes\`.`,
  },
  {
    slug: "dev-in-house-agent-notes",
    systemAgentAssignable: false,
    name: "Agent notes",
    description: "append_agent_notes / edit_agent_notes — persistent notes for this agent.",
    skillText: `# Agent notes

- **\`append_agent_notes\`** — append text.
- **\`edit_agent_notes\`** — replace full notes (read current block from system prompt first).

Not a substitute for repo files — see \`mcp-filesystem-repo\` / \`dev-in-house-workspace\`.`,
  },

  // ─── In-house: workspace vs skill library (split) — chat agents only ───
  {
    slug: "dev-in-house-workspace",
    systemAgentAssignable: false,
    name: "Agent workspace (.md / .txt)",
    description: "workspace_list_files, workspace_read_file, workspace_write_file, workspace_edit_file, workspace_delete_file.",
    skillText: `# Workspace tools

Private **.md** and **.txt** for this agent (not the product repo):

- \`workspace_list_files\`, \`workspace_read_file\`, \`workspace_write_file\`, \`workspace_edit_file\`, \`workspace_delete_file\`

## Related
- Stored skill playbooks → \`dev-in-house-skill-library\`.
- Repo source → \`mcp-filesystem-repo\`.`,
  },
  {
    slug: "dev-in-house-skill-library",
    systemAgentAssignable: false,
    name: "Skill library (list / get / add)",
    description: "list_agent_skills, get_agent_skill, add_agent_skill.",
    skillText: `# Skill library

- **\`list_agent_skills\`** — ids and metadata (not full body).
- **\`get_agent_skill\`** — full \`skill_text\` by id.
- **\`add_agent_skill\`** — create and link a new skill.

## Related
- Markdown workspace scratch → \`dev-in-house-workspace\`.`,
  },

  // ─── In-house: profile (split user vs agent name) — chat agents only ───
  {
    slug: "dev-in-house-user-identity",
    systemAgentAssignable: false,
    name: "User identity (edit_user_identity)",
    description: "Merge JSON into users.user_identity for the current thread user.",
    skillText: `# User identity

**\`edit_user_identity\`** — \`append\` or \`rewrite\` \`users.user_identity\` (JSON object string).

Use for structured preferences (timezone, stack, style). Do not store secrets as casual chat text.

## Related
- Display name of **this agent** → \`dev-in-house-agent-name\`.`,
  },
  {
    slug: "dev-in-house-agent-name",
    systemAgentAssignable: false,
    name: "Agent display name (edit_agent_name)",
    description: "Rename this agent via edit_agent_name.",
    skillText: `# Agent name

**\`edit_agent_name\`** — updates the agent’s display name when the user asks to rename you.

Rare for routine tasks.`,
  },

  // ─── Process ───
  {
    slug: "dev-code-review-workflow",
    name: "Code review (evidence-based)",
    description: "How to review using bash/git tools; severity; no fake test results.",
    skillText: `# Code review

## Evidence
Use **bash** to read files and run \`git\` diffs; never claim tests passed without tool output.

## Checks
Correctness → security → maintainability → tests.

## Output
Severity groups, file paths, actionable fixes.`,
  },
];

async function insertSkill(queryInterface, { slug, name, description, skillText, systemAgentAssignable }) {
  await queryInterface.sequelize.query(
    `INSERT INTO skills (name, slug, description, skill_text, system_agent_assignable, created_at, updated_at)
     SELECT :name, :slug, :description, :skillText, :systemAgentAssignable, NOW(), NOW()
     WHERE NOT EXISTS (SELECT 1 FROM skills WHERE slug = :slug)`,
    {
      replacements: { name, slug, description, skillText, systemAgentAssignable: systemAgentAssignable !== false },
    },
  );
}

module.exports = {
  async up(queryInterface, _Sequelize) {
    for (const skill of SKILLS) {
      await insertSkill(queryInterface, skill);
    }
  },

  async down(queryInterface, _Sequelize) {
    for (const { slug } of [...SKILLS].reverse()) {
      await queryInterface.sequelize.query(`DELETE FROM skills WHERE slug = :slug`, {
        replacements: { slug },
      });
    }
  },
};
