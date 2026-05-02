"use strict";

/**
 * Slice 12 — Bash vendor split + default allow_sdk_bash to TRUE.
 *
 * What this migration does
 * ------------------------
 * 1. Inserts the auto-assigned **bash core** skills, vendor-split:
 *      - `dev-in-house-bash-sdk`   — Anthropic SDK's `Bash` tool
 *        (capitalised; persistent shell session, run_in_background,
 *        KillShell). Auto-injected for Anthropic agents whose row has
 *        `allow_sdk_bash = true`.
 *      - `dev-in-house-bash-codex` — Codex SDK's native shell.
 *        Auto-injected for non-Anthropic agents whose row has
 *        `allow_sdk_bash = true`.
 *
 *    These are the ONLY auto-assigned shell skills. Other shell-
 *    related skills (`gh-cli`, `mcp-bash-build-test`, etc.) are
 *    admin-attached via the admin UI; they get their own vendor
 *    variants below.
 *
 * 2. Inserts admin-attachable Codex variants of the existing bash
 *    skills (the SDK variants stay under their original slugs):
 *      - `gh-cli-codex`            — sibling of `gh-cli`.
 *      - `mcp-bash-build-test-codex` — sibling of `mcp-bash-build-test`.
 *    The admin UI lists both variants; admins pick the right one for
 *    the agent's vendor.
 *
 * 3. Backfills `allow_sdk_bash = true` on every agent row, then flips
 *    the column default to TRUE. Admins can opt OUT a specific agent
 *    via the admin UI post-migration.
 *
 * Idempotent: re-running is a no-op (INSERT IF NOT EXISTS, conditional
 * UPDATE, conditional default change).
 *
 * @type {import('sequelize-cli').Migration}
 */

const BASH_SDK_SKILL = {
  slug: "dev-in-house-bash-sdk",
  name: "Shell access (SDK Bash)",
  description:
    "Anthropic SDK's built-in `Bash` tool (capitalised). Auto-injected for Anthropic agents with allow_sdk_bash=true.",
  skillText: `# Shell access — SDK \`Bash\`

You have access to the **Claude Agent SDK's built-in \`Bash\` tool** (capitalised). This is a persistent shell session for the duration of your turn — \`cwd\` and environment variables survive across calls, and you can launch long-running commands with \`run_in_background\` and stop them with the companion \`KillShell\`.

## Capabilities
- **Persistent session.** Successive \`Bash\` calls share the same shell, so \`cd\` carries forward, exported env vars stay set, and shell functions you define persist.
- **\`run_in_background: true\`** — fires the command and returns immediately with a shell id. Use for servers, watchers, or long builds. Read incremental output with \`BashOutput\` and stop with \`KillShell\`.
- **Real exit codes** — the tool reports the command's exit status structurally, so you can branch on success/failure.

## Where to run
Your cwd is the spawned subprocess's working directory — typically your workspace root (deep-agent executors get the caller's workspace as cwd). Bare relative paths resolve there.

## Rules
1. **One command per call** when iterating; chain with \`&&\` only when intent is "abort on first failure" and you don't need separate exit-code reads.
2. **Don't print secrets.** Tokens like \`GITHUB_PERSONAL_ACCESS_TOKEN\` are in the env — never \`echo\` or log them.
3. **Quote paths with spaces.** Standard shell quoting rules apply.
4. **Report stderr honestly.** Don't claim success if the exit code is non-zero.

## Related skills (admin-attached)
- \`gh-cli\` — git + gh CLI patterns. Same \`Bash\` tool, structured guidance for git workflows.
- \`mcp-bash-build-test\` — npm/pytest/cargo/etc. Same \`Bash\` tool, build/test conventions.
- \`mcp-filesystem-repo\` — when you need to **read or edit code** without running it. The \`Bash\` tool runs commands; filesystem MCP edits files. Use both as needed.`,
};

const BASH_CODEX_SKILL = {
  slug: "dev-in-house-bash-codex",
  name: "Shell access (Codex shell)",
  description:
    "Codex SDK's native shell. Sandbox-mode-driven; capabilities depend on whether allow_sdk_bash gates `workspace-write` or `danger-full-access`.",
  skillText: `# Shell access — Codex shell

You can execute shell commands via Codex's native command surface. Codex's runtime emits a \`command_execution\` item for each command you run — this is the equivalent of Anthropic's \`Bash\` tool but with a different lifecycle.

## Sandbox mode determines what you can do
Your runtime is configured with one of two sandbox modes, derived from your agent's \`allow_sdk_bash\` flag:

- **\`danger-full-access\`** (\`allow_sdk_bash = true\`, the default after migration 126): unconstrained shell. You can run any command, reach the network, modify files anywhere the process has permission. Use carefully.
- **\`workspace-write\`** (\`allow_sdk_bash = false\`): file ops constrained to your cwd, network access restricted, shell commands constrained to the workspace. Some commands (e.g. arbitrary network calls) will fail or be denied — don't fight the sandbox; if a command is rejected, ask the user / orchestrator whether the restriction should be lifted.

## Lifecycle
Each command is one-shot exec — there is **no persistent shell session** like Anthropic's \`Bash\`. \`cd\` and exported env vars do **not** carry between commands. To work in a non-default directory, prefix each command with \`cd <dir> && …\` or pass the directory inline.

## Rules
1. **One command per call**, fully self-contained. Use \`&&\` chains for short pipelines; use a heredoc-wrapped script for anything multi-step.
2. **Don't print secrets.** Tokens in the env (e.g. \`OPENAI_API_KEY\`, \`GITHUB_PERSONAL_ACCESS_TOKEN\`) must never appear in your output.
3. **Quote paths with spaces.** Standard shell quoting rules apply.
4. **Report stderr honestly.** Don't claim success if the command failed.
5. **No background commands.** Codex has no equivalent of \`run_in_background\`; long-running processes block the turn until done. For builds or watchers, prefer time-bounded commands and re-run as needed.

## Related skills (admin-attached)
- \`gh-cli-codex\` — git + gh CLI patterns. Same shell, structured guidance for git workflows on the Codex path.
- \`mcp-bash-build-test-codex\` — npm/pytest/cargo/etc. Same shell, build/test conventions.
- Filesystem MCP — when you need to **read or edit code** without running it. The shell runs commands; the filesystem MCP edits files (lowercase \`read_text_file\` / \`write_file\` / \`edit_file\`). Use both as needed.`,
};

const GH_CLI_CODEX_SKILL = {
  slug: "gh-cli-codex",
  name: "Git & GitHub CLI (git + gh, Codex shell)",
  description:
    "All git operations (clone, commit, push, branch, merge) and GitHub operations (PRs, issues, checks) via git and gh CLI through the Codex SDK shell.",
  skillText: `# Git & GitHub CLI (\`git\` + \`gh\`) — Codex path

## What this is
Both **\`git\`** and **\`gh\`** CLIs are installed in the container.
Use them through the **Codex shell** (your runtime's native shell command surface) — run commands like any other shell command. Each command is one-shot exec; \`cd\` and env vars do **not** persist between calls.

## Authentication

### git — HTTPS + PAT
> **SSH is NOT available** in this container. Do **not** use \`git@github.com:…\` URLs.

\`\`\`bash
# Clone with PAT (one-shot — pass cd inline because the shell isn't persistent)
git clone https://x-access-token:\${GITHUB_PERSONAL_ACCESS_TOKEN}@github.com/OWNER/REPO.git /path/to/repo

# Fix remote for an already-cloned repo
cd /path/to/repo && git remote set-url origin https://x-access-token:\${GITHUB_PERSONAL_ACCESS_TOKEN}@github.com/OWNER/REPO.git
\`\`\`

### gh — auto-authenticated
\`gh\` uses the **GH_TOKEN** env var (pre-configured). No \`gh auth login\` needed.

---

## Git operations

### Basics
\`\`\`bash
cd /path/to/repo && git status
cd /path/to/repo && git diff
cd /path/to/repo && git log --oneline -20
cd /path/to/repo && git add -A && git commit -m "feat: description"
\`\`\`

### Branching & remote
\`\`\`bash
cd /path/to/repo && git checkout -b feature/my-branch
cd /path/to/repo && git push origin feature/my-branch
cd /path/to/repo && git pull origin main
\`\`\`

---

## GitHub operations (gh CLI)

### Pull Requests
\`\`\`bash
cd /path/to/repo && gh pr create --title "feat: add feature X" --body "Description" --base main
cd /path/to/repo && gh pr list
cd /path/to/repo && gh pr merge <number> --squash
\`\`\`

### Issues / Checks
\`\`\`bash
cd /path/to/repo && gh issue list
cd /path/to/repo && gh pr checks <number>
\`\`\`

---

## Rules
1. **Always prefix \`cd\`** to position yourself before each git/gh command — the Codex shell does NOT persist cwd between calls.
2. **HTTPS + PAT only** — never use SSH URLs (\`git@github.com:…\`).
3. **Push your branch before creating a PR.**
4. Use \`--base\` to specify the target branch explicitly.
5. **Sandbox awareness**: when \`allow_sdk_bash=false\`, network operations may be restricted by the \`workspace-write\` sandbox. \`git push\` / \`gh pr create\` typically need network access — if the agent is restricted, surface that to the orchestrator.
6. Report stderr honestly — only claim success after real tool output.
7. Never print or log tokens.

## Not in this skill
- **Reading/editing files** without git → filesystem MCP (\`read_text_file\` / \`write_file\` / \`edit_file\`).
- **Tests/builds** → \`mcp-bash-build-test-codex\`.`,
};

const BUILD_TEST_CODEX_SKILL = {
  slug: "mcp-bash-build-test-codex",
  name: "Build, test, lint (Codex shell)",
  description:
    "Run package managers, test runners, linters, typecheck via the Codex SDK shell.",
  skillText: `# Build & test — Codex shell

## Tool
You execute commands via the **Codex shell** (your runtime's native command surface). One-shot exec — \`cd\` and env vars do not persist between calls. Long-running processes block the turn until they finish; there is no equivalent of \`run_in_background\`.

## Scope
**Tooling**: \`npm\`/\`pnpm\`/\`yarn\`, \`pytest\`, \`jest\`, \`cargo test\`, \`go test\`, formatters, linters, typecheckers — run the **narrowest** command first when iterating.

## Practices
- Always prefix \`cd <repo>\` before the command, since the shell isn't persistent.
- Time-bound long runs (e.g. \`timeout 300 npm test\`) so you don't blow the turn budget.
- Summarize **actual** stdout/stderr and exit behavior from tool output.
- Do not claim green tests without evidence.

## Sandbox awareness
When \`allow_sdk_bash=false\` (\`workspace-write\` sandbox), commands that reach the network or write outside the workspace are constrained. \`npm install\` typically needs network access; \`pytest\` writing artifacts outside cwd may be denied. If a command fails because of sandbox restrictions, surface that to the orchestrator rather than rewriting the command unsafely.

## Not in this skill
- **Git** operations → \`gh-cli-codex\`.
- **Editing source** for review without running suite → filesystem MCP (\`read_text_file\` / \`edit_file\`).`,
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
    // 1. Auto-assigned bash core skills (vendor-split).
    await upsertLockedSkill(queryInterface, BASH_SDK_SKILL);
    await upsertLockedSkill(queryInterface, BASH_CODEX_SKILL);

    // 2. Admin-attachable Codex variants of the existing bash skills.
    //    The original `gh-cli` and `mcp-bash-build-test` slugs stay
    //    in place as the SDK variants — their bodies (after migration
    //    122) are already SDK-flavoured. Admins pick the right slug
    //    when assigning.
    await upsertLockedSkill(queryInterface, GH_CLI_CODEX_SKILL);
    await upsertLockedSkill(queryInterface, BUILD_TEST_CODEX_SKILL);

    // 3. Backfill `allow_sdk_bash = true` on every agent row.
    //    Per slice 12: default-on for both vendors. Admins can disable
    //    a specific agent post-migration via the admin UI.
    await queryInterface.sequelize.query(
      `UPDATE agents
          SET allow_sdk_bash = true,
              updated_at = NOW()
        WHERE allow_sdk_bash = false`,
    );

    // 4. Flip the column default to TRUE so newly-created agents
    //    inherit on-by-default.
    await queryInterface.changeColumn("agents", "allow_sdk_bash", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });
  },

  async down(queryInterface, Sequelize) {
    // Re-flip the column default. Don't reset row values — flipping
    // every row back to false would silently strip shell access from
    // agents the user has been running in production.
    await queryInterface.changeColumn("agents", "allow_sdk_bash", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    // Skill rows: leave new variants in place. Removing them would
    // break agents that have been auto-assigned the SDK/Codex bash
    // skill since this migration ran.
  },
};
