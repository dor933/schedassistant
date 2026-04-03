"use strict";

/**
 * Seeds reusable Skill rows (no `agents_skills` rows — link agents to skills via the UI).
 * Columns match `Skill`: name, slug, description, skill_text.
 * Idempotent: skips inserts when slug already exists.
 *
 * Covers MCP servers from `mcp_servers` (filesystem, bash, fetch, github, docker,
 * massive_market_data) plus in-house tools from `agent_service` (consult/delegate,
 * workspace_*, skills CRUD, ongoing requests, notes, edit_user_identity, edit_agent_name).
 *
 * If an older revision of this migration already ran (single skill only), run
 * `sequelize-cli db:migrate:undo` once for this file, then `db:migrate` again — or
 * insert the missing rows manually with the same slugs as `SKILLS` below.
 *
 * Legacy slugs to remove manually if already seeded: \`dev-fetch-docker-mcp\` (split into
 * \`dev-fetch-mcp\` + \`dev-docker-mcp\`); \`dev-in-house-tools-routing\` (split into
 * \`dev-in-house-collaboration\`, \`dev-in-house-tasks-and-notes\`,
 * \`dev-in-house-workspace-and-skills\`, \`dev-in-house-profile\`).
 *
 * @type {import('sequelize-cli').Migration}
 */

/** @type {{ slug: string; name: string; description: string; skillText: string }[]} */
const SKILLS = [
  {
    slug: "container-git-and-github-mcp",
    name: "Git & GitHub (container MCP)",
    description:
      "Bash MCP for git CLI; GitHub MCP for API. Uses GIT_SSH_COMMAND and GITHUB_PERSONAL_ACCESS_TOKEN.",
    skillText: `# Git & GitHub — container MCP workflow

## When this applies
Local **git** (clone, status, commit, push, branches, remotes) and **GitHub.com** API (issues, PRs, repo metadata).

## Environment (never echo secrets)
- **GIT_SSH_COMMAND** — SSH remotes (\`git@github.com:...\`).
- **GITHUB_PERSONAL_ACCESS_TOKEN** — Reaches MCP subprocesses; **github** MCP uses it for the API.

## Tools

| Goal | MCP server (DB name) |
|------|-------------------------|
| \`git\` CLI | **bash** (\`mcp-shell\`) |
| GitHub REST / API | **github** (\`@modelcontextprotocol/server-github\`) |
| Repo files on disk | **filesystem** (under allowed roots, e.g. \`/app/data\`) — not a substitute for \`git\` network ops |

Tool names may be prefixed; pick by server + description.

## Rules
1. Claim success only after real tool output.
2. \`cd\` to repo root in shell commands when needed.
3. SSH vs HTTPS: match remote type; token does not auto-auth all HTTPS git URLs unless configured.
4. Report errors from stderr honestly.`,
  },

  {
    slug: "dev-filesystem-bash-mcp",
    name: "Code & commands (filesystem + bash MCP)",
    description:
      "Edit and run code via filesystem MCP under /app/data and bash MCP for builds, tests, and scripts.",
    skillText: `# Filesystem + bash MCP — implement and verify code

## When this applies
Writing or changing source, running **tests**, **linters**, **builds**, package installs, or one-off scripts in the dev environment.

## MCP servers

| Server (DB name) | Role |
|------------------|------|
| **filesystem** | \`@modelcontextprotocol/server-filesystem\` — allowed root **/app/data**. Read/write project files for implementation. |
| **bash** | \`mcp-shell\` — Run shell commands: \`npm\`/\`pnpm\`/\`yarn\`, \`pytest\`, \`jest\`, \`cargo test\`, \`go test\`, formatters, etc. |

## Not the same as workspace tools
- \`workspace_*\` tools = this agent’s private **.md / .txt** scratch area (see separate skill). They are **not** the product repo.
- For real code under clones/workspaces on disk, use **filesystem** + **bash** MCP tools.

## Practices
1. Prefer **absolute paths** under \`/app/data/...\` when cwd is unclear.
2. Run the narrowest test command first (single file or pattern) when iterating.
3. Paste or summarize **actual** command output; never invent exit codes or logs.
4. After edits, run relevant tests or typecheck if the stack supports it.`,
  },

  {
    slug: "dev-fetch-mcp",
    name: "HTTP & docs (fetch MCP)",
    description:
      "Fetch MCP (uvx mcp-server-fetch) for GET requests: docs, OpenAPI, release notes, public HTTP research.",
    skillText: `# fetch MCP — HTTP GET for docs and research

## Server
- DB name: **fetch** — \`uvx\` + \`mcp-server-fetch\`.

## When this applies
- **HTTP GET** of public docs, OpenAPI/JSON specs, release notes, changelogs.
- Library or API version research **before** coding.
- Anything that is “pull this URL and read the response,” not local files or git.

## Practices
- Do not put secrets or tokens in URLs.
- Prefer official docs URLs; verify you are on the intended host.

## Not for
- **Git** remotes or GitHub API → **bash** + **github** MCP (see Git & GitHub skill).
- Reading/writing **project source on disk** → **filesystem** MCP.
- **Container** runtime state → **docker** skill (\`dev-docker-mcp\`).`,
  },

  {
    slug: "dev-docker-mcp",
    name: "Containers (docker MCP)",
    description:
      "Docker MCP (@alisaitteke/docker-mcp) for images, containers, and diagnostics — not for git or HTTP docs.",
    skillText: `# docker MCP — containers and images

## Server
- DB name: **docker** — \`@alisaitteke/docker-mcp\`.

## When this applies
- Inspect or manage **Docker**: images, running containers, logs, diagnostics relevant to the user’s task.
- If the MCP tool is awkward for a one-off, **bash** MCP can run \`docker\` CLI — still use **real** command output only.

## Not for
- **Git** or GitHub → **bash** + **github** MCP.
- **HTTP GET** of arbitrary URLs / reading web docs → **fetch** MCP (\`dev-fetch-mcp\`).
- **Application source files** on the host filesystem → **filesystem** MCP (and **bash** for local commands).`,
  },

  {
    slug: "dev-massive-market-mcp",
    name: "Market data (massive_market_data MCP)",
    description:
      "Optional Polygon/massive MCP for market data; only when the task needs financial time series or quotes.",
    skillText: `# massive_market_data MCP

## When this applies **only**
Tasks that need **market or financial data** (quotes, aggregates, ticker metadata) and the user expects data from the Massive/Polygon-style API.

## Server
- DB name: **massive_market_data** — env resolves **MASSIVE_API_KEY** from the agent container into the MCP process (same pattern as other MCP env merges).

## When **not** to use
General backend coding, git, Docker, or GitHub — use the other dev skills instead.`,
  },

  {
    slug: "dev-in-house-collaboration",
    name: "Peer & deep agents (consult, delegate)",
    description:
      "In-house tools: list_agents + consult_agent (sync); list_system_agents + delegate_to_deep_agent (async).",
    skillText: `# In-house tools — collaboration with other agents

Implemented in **agent_service** (not MCP). Tool names are exact.

## Tier 1 — peer agents (sync)

| Step | Tool |
|------|------|
| Discover peers | \`list_agents\` (optional \`query\` to filter) |
| Ask another **fellow** agent | \`consult_agent\` with \`targetAgentId\` + \`request\` |

You get the answer **in this conversation** (subject to locks/timeouts).

## Tier 2 — system / deep agents (async)

| Step | Tool |
|------|------|
| Discover specialists | \`list_system_agents\` |
| Hand off a long task | \`delegate_to_deep_agent\` with \`systemAgentSlug\` + \`request\` |

You **do not** get the result immediately; the user is notified when the deep agent finishes.

## Routing rules
- “Ask another agent” / peer help → **\`list_agents\`** + **\`consult_agent\`**, not \`list_system_agents\`.
- Heavy multi-step work that should run in the background → **\`delegate_to_deep_agent\`** after **\`list_system_agents\`**.
- Do not call \`consult_agent\` on yourself.

## Related (other skills)
- Ongoing requests and notes → \`dev-in-house-tasks-and-notes\`.
- Workspace files and skill library → \`dev-in-house-workspace-and-skills\`.`,
  },

  {
    slug: "dev-in-house-tasks-and-notes",
    name: "Ongoing requests & agent notes",
    description:
      "In-house: add_ongoing_request / remove_ongoing_request; append_agent_notes / edit_agent_notes.",
    skillText: `# In-house tools — task tracking and persistent notes

## Ongoing requests
- **\`add_ongoing_request\`** — Record work that spans multiple messages (follow-ups, pending items). Shown in the system prompt until removed.
- **\`remove_ongoing_request\`** — Pass the \`request_id\` from the **Ongoing requests** section when the item is done.

Use when the user explicitly needs something to **stay on the radar** across turns.

## Agent notes
- **\`append_agent_notes\`** — Append text to your persistent notes (project facts, conventions, URLs worth remembering for **this agent**).
- **\`edit_agent_notes\`** — Replace the whole notes block (or clear with empty string). Read current notes from the system prompt first.

Notes are **not** a substitute for product code on disk — see \`dev-in-house-workspace-and-skills\` for \`workspace_*\` vs repo.

## Related
- Talking to other agents → \`dev-in-house-collaboration\`.`,
  },

  {
    slug: "dev-in-house-workspace-and-skills",
    name: "Agent workspace files & skill library",
    description:
      "In-house workspace_* (.md/.txt); list_agent_skills, get_agent_skill, add_agent_skill — vs filesystem MCP for real code.",
    skillText: `# In-house tools — workspace scratch files and reusable skills

## Agent workspace (private artifacts)
Only **.md** and **.txt** in this agent’s workspace folder:

- **\`workspace_list_files\`** — List files.
- **\`workspace_read_file\`** — Read one file.
- **\`workspace_write_file\`** — Create or overwrite.
- **\`workspace_edit_file\`** — Replace one exact snippet.
- **\`workspace_delete_file\`** — Delete.

Use for plans, exports, drafts, or notes **not** meant to live in the application repository.

## Skill library (stored instructions)
- **\`list_agent_skills\`** — \`id\`, \`name\`, \`slug\`, \`description\` (not full body).
- **\`get_agent_skill\`** — Full **skill_text** by \`skill_id\`.
- **\`add_agent_skill\`** — Create a new skill and attach it to this agent when the user wants a reusable playbook.

## vs application code
- **Product / repo source** under the environment (e.g. \`/app/data\`) → **filesystem** MCP + **bash** MCP — not \`workspace_*\`.

## Related
- User-facing JSON prefs → \`dev-in-house-profile\` (\`edit_user_identity\`).`,
  },

  {
    slug: "dev-in-house-profile",
    name: "User identity & agent display name",
    description:
      "In-house: edit_user_identity (users.user_identity JSONB); edit_agent_name — sparingly for dev tasks.",
    skillText: `# In-house tools — user and agent profile

## User identity
- **\`edit_user_identity\`** — Updates \`users.user_identity\` (JSONB) for the **current thread user**.
  - \`action: "rewrite"\` — Replace entire object; use a JSON **object** string.
  - \`action: "append"\` — Shallow-merge keys into the existing object.

Use for durable preferences (e.g. timezone, stack, formatting prefs) when the user asks you to remember them structurally — **not** for secrets in plain text in chat.

## Agent name
- **\`edit_agent_name\`** — Changes this agent’s display name. Rarely needed for routine coding; use when the user renames the assistant.

## Not for
- Repo files or project code → **filesystem** / **bash** MCP.
- Long procedural playbooks → **\`add_agent_skill\`** (see \`dev-in-house-workspace-and-skills\`).`,
  },

  {
    slug: "dev-code-review-workflow",
    name: "Code review (evidence-based)",
    description:
      "Review code using filesystem/git tools; structure findings; never claim runs without tool output.",
    skillText: `# Code review — workflow

## Evidence
- Read and reason from **actual** file contents (**filesystem** MCP) and diffs (**bash** + \`git\`).
- **Never** claim tests/builds passed without tool output showing it.
- Follow the conversation’s honesty rules: no fabricated tool results.

## What to check (typical order)
1. **Correctness** — logic, edge cases, error paths.
2. **Security** — injection, authz, secrets handling, unsafe defaults.
3. **Maintainability** — structure, naming, duplication, API clarity.
4. **Tests** — coverage of critical paths; suggest concrete test cases if missing.

## Output style
- Group by **severity** (e.g. blocking vs suggestion).
- Reference **paths** (and lines when known from tool output).
- Prefer actionable fixes over vague opinions.

## Scope
- If the change is huge, prioritize high-risk files and summarize remaining surface area.`,
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
