"use strict";

/**
 * Adds a "Phase 2.5: External Expertise & Research" section to the
 * `epic-task-workflow` skill, documenting the two new tools available to
 * the Epic Orchestrator:
 *
 *   - consult_agent        — synchronous peer consultation (any agent)
 *   - delegate_web_search  — asynchronous web search (restricted to the
 *                            `web_search` system agent; no other system
 *                            agent can be targeted from this tool)
 *
 * Also updates the tool reference table to include these two tools.
 *
 * All operations use targeted REPLACE calls so the migration is idempotent
 * and will not clobber unrelated edits.
 *
 * @type {import('sequelize-cli').Migration}
 */

// ─── 1. Insert Phase 2.5 between Phase 2 and Phase 3 ────────────────────────

const OLD_PHASE_BOUNDARY = `---

## Phase 3: Execute & Review Tasks`;

const NEW_PHASE_BOUNDARY = `---

## Phase 2.5: External Expertise & Research (optional)

Before (or during) execution, you may need information that is not in the project files and not in your training knowledge. You have two tools for this:

### \`delegate_web_search\` — external information lookup
- Use this to look up **library documentation, API references, current best practices, package versions, framework changelogs**, or any factual information from the public internet.
- This is the ONLY way to reach the Web Search Agent. You cannot delegate to any other system agent from this graph.
- It is **asynchronous** — the moment you call it, your current turn ends. You will be re-invoked automatically with the search result as a new message.
- Ideal timing: **during Phase 2 (planning)** when you need to verify something before writing the plan. Example: "What is the latest stable version of Drizzle ORM and does it support PostgreSQL arrays?"
- You may also call it mid-execution (Phase 3) if a task fails because of a library behavior you need to verify before retrying — but be aware that your turn ends, so auto-continuation pauses until the result returns.
- Do NOT use it for: requirements, preferences, scope decisions (ask the user), information already in the project files (read the files), or anything you already know.

### \`consult_agent\` — synchronous peer consultation
- Use this when **another agent has domain expertise** you need: security review, architectural opinion, knowledge of a specific codebase area, or sanity-checking a risky approach.
- First call \`list_agents\` to discover who is available and what they specialize in.
- This is **synchronous** — your turn blocks until the consulted agent replies (up to 5 minutes). The orchestrator's thread lock is held during the consultation, so other users talking to you will receive a "busy" notice. This is acceptable if the consultation is genuinely needed for the quality of the task.
- Ideal timing: **Phase 2 (planning)** or between stages when you are uncertain about an approach. Mid-execution is also fine if it will materially improve the task outcome.
- Do NOT use it for: things you already know, vague "what do you think" questions, or as a substitute for asking the user about scope.

### Rules for both tools
- **Use judiciously.** These tools cost time. If you can answer from your own knowledge or by reading project files, do that instead.
- **Ask the user, not an agent**, for requirements, preferences, scope, and priorities.
- **Gather external information early** (Phase 2) when possible, so the plan is informed before execution begins.
- You do NOT have access to any other system-agent delegation tool. \`delegate_web_search\` is your only system-agent channel.

---

## Phase 3: Execute & Review Tasks`;

// ─── 2. Update the tool reference table ────────────────────────────────────

const OLD_TOOL_TABLE_HEADER = `| Tool | Purpose |
|------|---------|
| \`list_projects\` | Find the user's projects and their IDs |`;

const NEW_TOOL_TABLE_HEADER = `| Tool | Purpose |
|------|---------|
| \`list_agents\` | Discover which peer agents exist and what they specialize in (prerequisite for \`consult_agent\`) |
| \`consult_agent\` | Synchronously consult a peer agent for domain expertise (Phase 2.5) |
| \`delegate_web_search\` | Asynchronously look up external info via the Web Search Agent — the ONLY system agent available (Phase 2.5) |
| \`list_projects\` | Find the user's projects and their IDs |`;

module.exports = {
  async up(queryInterface) {
    const now = new Date();

    // Insert Phase 2.5 section
    await queryInterface.sequelize.query(
      `UPDATE skills
         SET skill_text = REPLACE(skill_text, :oldText, :newText),
             updated_at = :now
       WHERE slug = 'epic-task-workflow'`,
      {
        replacements: {
          oldText: OLD_PHASE_BOUNDARY,
          newText: NEW_PHASE_BOUNDARY,
          now,
        },
      },
    );

    // Prepend the three new tools to the tool reference table
    await queryInterface.sequelize.query(
      `UPDATE skills
         SET skill_text = REPLACE(skill_text, :oldText, :newText),
             updated_at = :now
       WHERE slug = 'epic-task-workflow'`,
      {
        replacements: {
          oldText: OLD_TOOL_TABLE_HEADER,
          newText: NEW_TOOL_TABLE_HEADER,
          now,
        },
      },
    );
  },

  async down(queryInterface) {
    const now = new Date();

    await queryInterface.sequelize.query(
      `UPDATE skills
         SET skill_text = REPLACE(skill_text, :newText, :oldText),
             updated_at = :now
       WHERE slug = 'epic-task-workflow'`,
      {
        replacements: {
          oldText: OLD_TOOL_TABLE_HEADER,
          newText: NEW_TOOL_TABLE_HEADER,
          now,
        },
      },
    );

    await queryInterface.sequelize.query(
      `UPDATE skills
         SET skill_text = REPLACE(skill_text, :newText, :oldText),
             updated_at = :now
       WHERE slug = 'epic-task-workflow'`,
      {
        replacements: {
          oldText: OLD_PHASE_BOUNDARY,
          newText: NEW_PHASE_BOUNDARY,
          now,
        },
      },
    );
  },
};
