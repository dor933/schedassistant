"use strict";

/**
 * Seeds one Skill row per slug — assign skills to agents independently via the UI (`agents_skills`).
 * Idempotent: INSERT … WHERE NOT EXISTS on `slug`.
 *
 * MCP servers referenced: bash, fetch, github, docker, massive_market_data (see `mcp_servers` seed).
 *
 * @type {import('sequelize-cli').Migration}
 */

/** @type {{ slug: string; name: string; description: string; skillText: string }[]} */
const SKILLS = [
  // ─── MCP: git / GitHub / bash (split so agents can take git without GitHub API, etc.) ───
  {
    slug: "mcp-git-cli-bash",
    name: "Git CLI (bash MCP)",
    description: "Run git via bash/mcp-shell: clone, pull, push, branch, merge. Uses GIT_SSH_COMMAND when set.",
    skillText: `# Git CLI — bash MCP (\`mcp-shell\`)

## Server
- **bash** (DB name) — \`npx -y mcp-shell\`

## Scope
Local **git** only: \`clone\`, \`status\`, \`diff\`, \`log\`, \`branch\`, \`commit\`, \`pull\`, \`push\`, \`merge\`, \`rebase\`, \`remote\`, \`fetch\`, \`config\`, etc.

## Prefer SSH for Git (not the PAT)
The agent container mounts an SSH private key (e.g. \`/root/.ssh/id_rsa\`) and sets **GIT_SSH_COMMAND** so Git uses that key.

- For **clone / fetch / push** to GitHub, prefer remotes like \`git@github.com:OWNER/REPO.git\` — authentication is **SSH**, not **GITHUB_PERSONAL_ACCESS_TOKEN**.
- Avoid relying on HTTPS + PAT for \`git\` unless the user explicitly uses HTTPS remotes and has configured credentials.

## Rules
1. Only claim success after **real** tool output.
2. \`cd\` to the repo root in the same shell command when needed.
3. Report stderr honestly.

## Not in this skill
- **GitHub REST** (API fork, issues, PRs via API) → \`mcp-github-api\` (PAT applies there; SSH does not).
- **Reading/editing files** without git → \`mcp-bash-repo-files\`.
- **Tests/builds** → \`mcp-bash-build-test\`.`,
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
    slug: "mcp-bash-repo-files",
    name: "Repo files on disk (bash MCP)",
    description: "Read/write/list project files under /app/data via shell — not git-only, not CI commands.",
    skillText: `# Repo files — bash MCP

## Server
- **bash** (\`mcp-shell\`)

## Scope
**File operations** on the repo tree: \`cat\`, \`ls\`, \`find\`, \`sed\`, \`tee\`, heredocs, small edits — typically under \`/app/data/...\`.

There is no separate filesystem MCP; the shell is the path to on-disk files.

## Practices
- Prefer **absolute paths** when cwd is unclear.
- Paste real command output; never invent file contents.

## Not in this skill
- **Git** protocol operations → \`mcp-git-cli-bash\`.
- **npm test / pytest / build** → \`mcp-bash-build-test\`.
- Agent **workspace_*** \`.md\`/.\`txt\` scratch → \`dev-in-house-workspace\`.`,
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
- **Editing source** for review without running suite → \`mcp-bash-repo-files\`.`,
  },

  // ─── MCP: fetch / docker / market ───
  {
    slug: "dev-fetch-mcp",
    name: "HTTP GET (fetch MCP)",
    description: "uvx mcp-server-fetch for docs, OpenAPI, public URLs.",
    skillText: `# fetch MCP

## Server
- **fetch** — \`uvx mcp-server-fetch\`

## Scope
Public **HTTP GET**: docs, OpenAPI, changelogs, release pages.

## Not for
- GitHub API → \`mcp-github-api\`.
- Local repo files → \`mcp-bash-repo-files\`.
- Docker → \`dev-docker-mcp\`.`,
  },
  {
    slug: "dev-docker-mcp",
    name: "Docker (docker MCP)",
    description: "@alisaitteke/docker-mcp for images, containers, diagnostics.",
    skillText: `# docker MCP

## Server
- **docker**

## Scope
Container images, running containers, logs, diagnostics. Optionally **bash** for raw \`docker\` CLI with real output.

## Not for
- Git / GitHub API / fetch — other skills.`,
  },
  {
    slug: "dev-massive-market-mcp",
    name: "Market data (massive_market_data MCP)",
    description: "Massive/Polygon-style data; needs MASSIVE_API_KEY in MCP env.",
    skillText: `# massive_market_data MCP

## When
Financial / market data tasks only (quotes, aggregates, tickers).

## Server
- **massive_market_data** — \`MASSIVE_API_KEY\` via env merge.`,
  },

  // ─── In-house: collaboration (split peer vs deep) ───
  {
    slug: "dev-in-house-peer-agents",
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

  // ─── In-house: tracking & notes (split) ───
  {
    slug: "dev-in-house-ongoing-requests",
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
    name: "Agent notes",
    description: "append_agent_notes / edit_agent_notes — persistent notes for this agent.",
    skillText: `# Agent notes

- **\`append_agent_notes\`** — append text.
- **\`edit_agent_notes\`** — replace full notes (read current block from system prompt first).

Not a substitute for repo files — see \`mcp-bash-repo-files\` / \`dev-in-house-workspace\`.`,
  },

  // ─── In-house: workspace vs skill library (split) ───
  {
    slug: "dev-in-house-workspace",
    name: "Agent workspace (.md / .txt)",
    description: "workspace_list_files, workspace_read_file, workspace_write_file, workspace_edit_file, workspace_delete_file.",
    skillText: `# Workspace tools

Private **.md** and **.txt** for this agent (not the product repo):

- \`workspace_list_files\`, \`workspace_read_file\`, \`workspace_write_file\`, \`workspace_edit_file\`, \`workspace_delete_file\`

## Related
- Stored skill playbooks → \`dev-in-house-skill-library\`.
- Repo source → \`mcp-bash-repo-files\`.`,
  },
  {
    slug: "dev-in-house-skill-library",
    name: "Skill library (list / get / add)",
    description: "list_agent_skills, get_agent_skill, add_agent_skill.",
    skillText: `# Skill library

- **\`list_agent_skills\`** — ids and metadata (not full body).
- **\`get_agent_skill\`** — full \`skill_text\` by id.
- **\`add_agent_skill\`** — create and link a new skill.

## Related
- Markdown workspace scratch → \`dev-in-house-workspace\`.`,
  },

  // ─── In-house: profile (split user vs agent name) ───
  {
    slug: "dev-in-house-user-identity",
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

async function insertSkill(queryInterface, { slug, name, description, skillText }) {
  await queryInterface.sequelize.query(
    `INSERT INTO skills (name, slug, description, skill_text, created_at, updated_at)
     SELECT :name, :slug, :description, :skillText, NOW(), NOW()
     WHERE NOT EXISTS (SELECT 1 FROM skills WHERE slug = :slug)`,
    {
      replacements: { name, slug, description, skillText },
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
