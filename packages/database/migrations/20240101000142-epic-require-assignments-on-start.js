"use strict";

/**
 * Teach the orchestrator that `assignments` on `start_epic_task` is now
 * REQUIRED — the legacy "do the work yourself" / "Direct execution" mode
 * was removed.
 *
 * Background: the in-loop direct mode reliably fails. The orchestrator
 * marks the task `in_progress`, returns the "Now do this" instructions
 * to itself, then either stops without doing anything or calls
 * `complete_epic_task` with an empty diff and a fabricated success
 * summary. Forcing every task through the sub-agent dispatch path means
 * at least one Claude SDK `Task()` call has to run, surfacing real
 * failures (missing tools, scope errors, sub-agent claims of "no FS /
 * Bash") up front instead of after a silent no-op.
 *
 * Tool-side change: `start_epic_task`'s zod schema flips `assignments`
 * from `.optional()` to `.min(1)`, the "do the work yourself" branch is
 * deleted, and the tool description / capability gate is updated. This
 * migration mirrors that into the `epic-orchestrator-sdk` skill text so
 * the orchestrator's system prompt agrees with the new contract.
 *
 * Idempotent: `REPLACE` is a no-op when the OLD substring is absent
 * (e.g. after the migration has already been applied), so re-runs and
 * partial states are safe. Only the SDK skill is touched — the Codex
 * skill never had a sub-agent path.
 *
 * @type {import('sequelize-cli').Migration}
 */

const TARGET_SLUG = "epic-orchestrator-sdk";

// ─── 1. Replace the "Sub-agent roster (optional fan-out)" block ─────────────
//
// Anchor on the full block as written by migration 140's SDK_PHASE_3.
// Byte-for-byte match required.

const OLD_ROSTER_BLOCK = `## Sub-agent roster (optional fan-out)

Before listing tasks, scan your \`list_claude_sub_agents\` roster. Sub-
agent fan-out is a **feature you may use, NOT a requirement**:

- If a task touches multiple concerns (frontend + backend + DB + docs)
  and you have specialist sub-agents attached, plan to dispatch the
  work in parallel via \`Task("<sub-agent-id>", "<scope>")\`. A typical
  full-stack task fans out to 2–4 specialists.
- If you have no sub-agents — or the task is small / single-concern —
  you'll execute it yourself in-place using your own bound tools
  (filesystem MCP \`read_file\` / \`write_file\` / \`edit_file\`, Bash
  for tests / commits).`;

const NEW_ROSTER_BLOCK = `## Sub-agent roster (REQUIRED)

Before listing tasks, scan your \`list_claude_sub_agents\` roster. Every
task on this flow runs through at least one sub-agent — \`start_epic_task\`
will reject the call if you do not pass \`assignments\` with at least one
\`{ id, scope }\` entry. The legacy "do the work yourself" mode was
removed because the orchestrator's own tool loop reliably no-ops on it
(marks the task complete with an empty diff and a fabricated success).

- A multi-concern task (frontend + backend + DB + docs) fans out to 2–4
  specialist sub-agents in parallel via \`Task("<sub-agent-id>", "<scope>")\`.
- A small / single-concern task still requires a sub-agent — pick the
  one whose role best fits and pass it as the only entry in
  \`assignments\` with the full task scope.
- If your roster is empty, attach a \`claude_sub_agent\` to yourself in
  the admin UI before calling \`start_epic_task\`.`;

// ─── 2. Replace the per-task loop step 1 (mode bullets) ────────────────────

const OLD_STEP1 = `1. **Call \`start_epic_task\`.** The tool snapshots HEAD, marks the next
   ready task \`in_progress\`, and returns a working directory + base
   SHA + a "Now do this" block. Two modes:
   - **Sub-agent fan-out:** pass \`assignments: [{ id, scope }, ...]\`
     — one entry per specialist sub-agent. Each id must be a
     \`claude_sub_agent\` row attached to YOU (verify via
     \`list_claude_sub_agents\`). Bad ids are rejected before any state
     change.
   - **Direct execution:** omit \`assignments\` (or pass \`[]\`). You'll
     do the work yourself in this same turn.`;

const NEW_STEP1 = `1. **Call \`start_epic_task\`** with \`assignments: [{ id, scope }, ...]\`
   — REQUIRED, at least one entry. Each id must be a \`claude_sub_agent\`
   row attached to YOU (verify via \`list_claude_sub_agents\`); bad ids
   are rejected before any state change. The tool snapshots HEAD, marks
   the next ready task \`in_progress\`, and returns a working directory +
   base SHA + the dispatch plan to copy verbatim.`;

// ─── 3. Replace the per-task loop step 2 (work bullets) ────────────────────

const OLD_STEP2 = `2. **Do the work in your tool loop:**
   - **With sub-agents:** emit the listed \`Task()\` calls in a SINGLE
     assistant message — the SDK runs them concurrently inline.
     (Splitting them across messages serializes execution.) Wait for
     ALL \`Task()\` results to return; each includes that sub-agent's
     \`## Files changed\` section.
   - **Direct:** read / edit / test / commit using your bound tools.
     Stay strictly within the task's scope; commit logical units
     locally as you go.`;

const NEW_STEP2 = `2. **Dispatch the sub-agents.** Emit the listed \`Task()\` calls in a
   SINGLE assistant message — the SDK runs them concurrently inline.
   (Splitting them across messages serializes execution.) Wait for ALL
   \`Task()\` results to return; each includes that sub-agent's
   \`## Files changed\` section. Aggregate them for the
   \`complete_epic_task\` summary.`;

// ─── 4. Replace the Tool Reference row for `start_epic_task` ────────────────

const OLD_TOOL_ROW = `| \`start_epic_task\` | Begin work on the next ready task. \`assignments\` optional — pass for \`Task()\` sub-agent fan-out, omit for direct execution. |`;

const NEW_TOOL_ROW = `| \`start_epic_task\` | Begin work on the next ready task. \`assignments\` REQUIRED (≥1 entry) — every task is dispatched to at least one \`claude_sub_agent\` via \`Task()\`. |`;

// ─── 5. Drop the now-stale "tool-loop budget" note about direct execution ──

const OLD_BUDGET_NOTE = `### Tool-loop budget

The orchestrator's own tool loop is bounded (currently
\`MAX_TOOL_ROUNDS = 30\` per turn). Setup checks + sub-agent dispatch
+ finalize all share that budget. Direct execution that needs many
file rounds can hit the ceiling — for very large tasks, prefer slicing
into multiple smaller \`agent_tasks\` at planning time.`;

const NEW_BUDGET_NOTE = `### Tool-loop budget

The orchestrator's own tool loop is bounded (currently
\`MAX_TOOL_ROUNDS = 30\` per turn). Setup checks + sub-agent dispatch
+ finalize all share that budget — for very large tasks, prefer slicing
into multiple smaller \`agent_tasks\` at planning time so each task's
sub-agent fan-out + finalize fits within one turn.`;

// ─── Helper ───────────────────────────────────────────────────────────────

async function applyReplace(queryInterface, oldText, newText, now) {
  await queryInterface.sequelize.query(
    `UPDATE skills
       SET skill_text = REPLACE(skill_text, :oldText, :newText),
           updated_at = :now
     WHERE slug = :slug`,
    { replacements: { oldText, newText, now, slug: TARGET_SLUG } },
  );
}

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    await applyReplace(queryInterface, OLD_ROSTER_BLOCK, NEW_ROSTER_BLOCK, now);
    await applyReplace(queryInterface, OLD_STEP1, NEW_STEP1, now);
    await applyReplace(queryInterface, OLD_STEP2, NEW_STEP2, now);
    await applyReplace(queryInterface, OLD_TOOL_ROW, NEW_TOOL_ROW, now);
    await applyReplace(queryInterface, OLD_BUDGET_NOTE, NEW_BUDGET_NOTE, now);
  },

  async down(queryInterface) {
    const now = new Date();
    await applyReplace(queryInterface, NEW_BUDGET_NOTE, OLD_BUDGET_NOTE, now);
    await applyReplace(queryInterface, NEW_TOOL_ROW, OLD_TOOL_ROW, now);
    await applyReplace(queryInterface, NEW_STEP2, OLD_STEP2, now);
    await applyReplace(queryInterface, NEW_STEP1, OLD_STEP1, now);
    await applyReplace(queryInterface, NEW_ROSTER_BLOCK, OLD_ROSTER_BLOCK, now);
  },
};
