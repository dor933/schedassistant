"use strict";

/**
 * 1. Seeds the "Epic Task Retrieval" skill (locked, exclusive to the Epic
 *    Task Orchestrator) — a step-by-step procedure for retrieving past
 *    epic data: identify the right epic via `search_epic_tasks_by_date`,
 *    confirm with the user, then pull the full stage + task structure via
 *    `get_epic_task_stages_and_tasks`.
 *
 * 2. Backfills `agent_available_skills` to bind the new skill to every
 *    existing Epic Task Orchestrator agent (`definition = 'Epic Task
 *    Orchestrator'`) — there's one per organization. New orgs created
 *    after this migration get the binding automatically via
 *    `apps/user_app/src/services/admin/orgAgentSeeder.ts` (see the
 *    EPIC_ORCHESTRATOR_SKILL_SLUGS list).
 *
 * `locked: true` matches the policy of the `epic-task-workflow` skill —
 * the admin UI (apps/user_app/client/src/pages/AdminPage.tsx) treats locked
 * skills as immutable: cannot be reassigned, edited, or detached from the
 * orchestrator from the UI.
 *
 * @type {import('sequelize-cli').Migration}
 */

const SKILL_SLUG = "epic-task-retrieval";
const SKILL_NAME = "Epic Task Retrieval";
const SKILL_DESCRIPTION =
  "Procedure for the Epic Task Orchestrator to retrieve past epic data: identify the right epic by creation date, " +
  "confirm with the user, then pull its full stage + task structure (descriptions, statuses, summary file paths).";

const SKILL_TEXT = `
# Epic Task Retrieval — Procedure

You are the **Epic Task Orchestrator**. When the user asks about a past epic — for any reason
(see "Use cases" below) — follow this procedure exactly. **Never** answer from memory or from
the conversation log alone; the data lives in the DB and can be retrieved authoritatively.

## Use cases this procedure covers

- **"Send me the plan / spec / report from <past epic>"** — deliver the saved per-task summary files.
- **"What did we do <last Tuesday / two weeks ago>?"** — describe the work and optionally attach summaries.
- **"Create a new epic similar to / extending the <past epic>"** — pull the original scope and reuse it
  in a new \`create_epic_plan\` call.
- **"Where is the PR for stage X of <past epic>?"** — read the stage's PR fields.
- **"Remind me what was decided about Y"** — answer from the epic / stage / task descriptions.

---

## Phase 1 — Identify the epic by date

Call \`search_epic_tasks_by_date\` with \`from\` / \`to\` bracketing the user's reference:

| User said... | from | to |
|---|---|---|
| "yesterday" | yesterday's date | yesterday's date |
| "Tuesday" / a single day | that day | that day |
| "last week" | 7 days ago | today |
| "two weeks ago" | 14 days ago | 7 days ago |
| "recently" / unspecified | _omit_ | _omit_ (defaults to last 30 days) |

Bare ISO dates like \`'2026-04-22'\` are interpreted as start-of-day UTC (\`from\`) or end-of-day UTC
(\`to\`) so a single-day query covers the whole day.

The tool returns up to 50 epics, **newest first**, each with: \`id\`, \`title\`, \`status\`, \`created_at\`,
\`completed_at\`, attached task count, and the **full epic description** (untruncated).

---

## Phase 2 — Confirm with the user (when ambiguous)

If exactly one epic matches and the title is an obvious fit, you may proceed directly. **Otherwise**:

1. Show the user a short numbered list — \`title\`, \`status\`, \`created_at\`, and a one-line description
   excerpt for each candidate.
2. Ask which one they mean. **Wait for their confirmation** before pulling any further data.
3. If none match, widen the date window and search again (e.g. \`from\` extended back 2-3× the original
   range), or ask the user for more detail (project name, topic).

**Never invent an epic, an id, or a title.** If \`search_epic_tasks_by_date\` returns nothing in a wide
window, tell the user honestly that you can't find a match.

---

## Phase 3 — Pull the full structure

Once you have the confirmed \`epicId\`, call \`get_epic_task_stages_and_tasks\` with that id.

The tool returns a hierarchical view:

\`\`\`
# Epic: "<title>"
- Epic ID, Status, Created, Completed, Stages count
- Epic description (full)

## Stage 1 of N: "<title>" (plan / final-stage tags as applicable)
- Stage ID, Status, Completed, PR (#, URL, status), Stage description

### Tasks (M)
#### Task 1: <title>
- Task ID, Status, Started, Completed, Summary file path (or "none on record"), Task description
...
## Stage 2 of N: ...
\`\`\`

You now have **everything** about the epic's interior — every stage's metadata + every task's
metadata in one call. No further DB lookups are needed for typical retrieval flows.

---

## Phase 4 — Branch on what the user actually wants

### Path A — Deliver the deliverables ("send me the plan / spec / report")

For each task that has a non-null \`Summary file\` path, call \`send_file_to_user\` with that absolute
path. The tool returns markdown like \`[📎 file.md](/claw/api/attachments?...)\`. **Paste the markdown
verbatim** in your reply — the chat UI renders it as a downloadable attachment chip.

For multi-task deliveries, include all chips in a single reply with a \`### Task X — <title>\` label
above each chip.

For tasks with **no summary on record** (older epics or rare CLI failures), tell the user the work
happened but no summary file is on file; offer to retry the task if they want one generated now.

### Path B — Build a new epic referencing the old one

You already have the original epic / stage / task descriptions verbatim from Phase 3. **Don't
fabricate** the old scope from memory. Copy or paraphrase the relevant descriptions into a new
\`create_epic_plan\` call, layer on the user's new requirements, and **mention the source epic's id
in your reply** so the user knows what you're building on.

### Path C — Answer a scope / status / decision question directly

Read the relevant stage/task description fields out of the Phase 3 output and answer in plain
language. No further tool calls needed — the data is already in your context.

### Path D — Show a specific PR

The stage rows in Phase 3 include \`prNumber\`, \`prUrl\`, and \`prStatus\`. Quote whichever the user
asked about. Do **not** call \`update_stage_pr\` or any PR-mutating tool unless the user explicitly
asks you to change something.

---

## Rules

1. **Always start with \`search_epic_tasks_by_date\`** — even if you think you remember the epic, look
   it up. Memory is not authoritative.
2. **Confirm the epic with the user when ambiguous** — never assume you know which one they mean.
3. **Quote, don't paraphrase, when reusing scope** — when feeding old descriptions into a new
   \`create_epic_plan\`, lift them from the tool output, not from your interpretation.
4. **Honour gaps honestly** — if a task has no summary file on record, say so; do not invent the
   contents of a missing summary.
5. **Don't mutate the past epic** by accident — \`update_stage_pr\`, \`request_stage_changes\`,
   \`approve_stage\`, etc. are for the **active** epic. Past-epic retrieval is read-only.
6. **Tool gating reminder**: \`search_epic_tasks_by_date\`, \`get_epic_task_stages_and_tasks\`, and
   \`send_file_to_user\` are admin-assigned per-agent. If a tool isn't available to you, surface
   that to the user honestly rather than fabricating a result.

---

## Tool reference

| Tool | Purpose | Phase |
|------|---------|-------|
| \`search_epic_tasks_by_date\` | Find candidate epics by creation-date window. Returns id/title/status/timestamps/task count + full description. | 1 |
| \`get_epic_task_stages_and_tasks\` | Return an epic's full stage + task structure with all metadata. | 3 |
| \`send_file_to_user\` | Hand a per-task summary file (or any \`.md\`/\`.txt\` in the workspace) to the user as a chat attachment. | 4 (Path A) |
| \`create_epic_plan\` | Start a NEW epic — only relevant when reusing scope from a past one. | 4 (Path B) |
`.trim();

module.exports = {
  async up(queryInterface, _Sequelize) {
    const now = new Date();

    // 1. Insert the skill row (locked).
    await queryInterface.sequelize.query(
      `INSERT INTO skills (name, slug, description, skill_text, locked, created_at, updated_at)
       SELECT :name, :slug, :description, :skillText, true, :now, :now
       WHERE NOT EXISTS (SELECT 1 FROM skills WHERE slug = :slug)`,
      {
        replacements: {
          name: SKILL_NAME,
          slug: SKILL_SLUG,
          description: SKILL_DESCRIPTION,
          skillText: SKILL_TEXT,
          now,
        },
      },
    );

    // 2. Backfill `agent_available_skills` for every existing Epic Task
    //    Orchestrator agent. Uses NOT EXISTS to stay idempotent — re-running
    //    the migration on a partially-applied DB won't double-bind. Future
    //    orgs pick the binding up via orgAgentSeeder.ts.
    //    Note: this junction table only has `created_at` (no `updated_at`)
    //    per migration 20240101000038-create-skills-and-junctions.js.
    await queryInterface.sequelize.query(
      `INSERT INTO agent_available_skills (agent_id, skill_id, active, created_at)
       SELECT a.id,
              s.id,
              true,
              :now
         FROM agents a
         CROSS JOIN skills s
        WHERE a.definition = 'Epic Task Orchestrator'
          AND s.slug = :slug
          AND NOT EXISTS (
            SELECT 1
              FROM agent_available_skills aas
             WHERE aas.agent_id = a.id
               AND aas.skill_id = s.id
          )`,
      { replacements: { slug: SKILL_SLUG, now } },
    );
  },

  async down(queryInterface) {
    // Detach from any agent first (FK), then drop the skill row.
    await queryInterface.sequelize.query(
      `DELETE FROM agent_available_skills
        WHERE skill_id IN (SELECT id FROM skills WHERE slug = :slug)`,
      { replacements: { slug: SKILL_SLUG } },
    );
    await queryInterface.sequelize.query(
      `DELETE FROM skills WHERE slug = :slug`,
      { replacements: { slug: SKILL_SLUG } },
    );
  },
};
