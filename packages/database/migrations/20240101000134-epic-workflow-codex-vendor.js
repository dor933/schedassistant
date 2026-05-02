"use strict";

/**
 * Slice 23 — extends the Epic Task Workflow skill with a vendor-
 * conditional execution procedure.
 *
 * Slice 20 introduced the Anthropic sub-agent dispatch flow
 * (`start_epic_task` with `assignments`, parallel `Task()` calls,
 * `complete_epic_task`). That flow is correct ONLY when the orchestrator
 * runs on an Anthropic-vendor model — Codex's SDK has no parallel
 * sub-agent equivalent and concurrent codex sessions on one repo race
 * on the git index.
 *
 * The slice-23 codex flow is:
 *   1. (Optional) `plan_epic_task` — read-only Codex run that produces a
 *      Markdown plan. Lets the orchestrator scout consequential tasks
 *      before paying for write-side tokens.
 *   2. `start_epic_task_codex` — workspace-write Codex run that executes
 *      the task end-to-end inside ONE session, optionally seeded with
 *      the plan from step 1.
 *   3. `complete_epic_task` — shared lifecycle finalize, same tool both
 *      vendors use.
 *
 * Strategy: replace the slice-20 "Execute the next task (sub-agent
 * dispatch)" header phrase with a vendor-conditional wrapper that
 * teaches the orchestrator to read its own vendor + branch into the
 * matching procedure. Keeps the slice-20 Anthropic body intact (it stays
 * accurate); appends the new Codex body underneath. The model self-routes
 * based on which tools are actually bound to it (`start_epic_task` vs
 * `start_epic_task_codex` — see `epicGraph/callModel.ts` vendor-
 * conditional binding).
 *
 * The REPLACE anchor is a unique substring of the slice-20 NEW block
 * (specifically the section header line + the first sentence of its
 * intro). On a re-run, the substring no longer matches the slice-23
 * version → no-op. Idempotent.
 *
 * @type {import('sequelize-cli').Migration}
 */

const SKILL_SLUG = "epic-task-workflow";

// Anchor — a unique fragment from the slice-20 block we're upgrading.
// Includes the section header + the first sentence of the intro so a
// substring REPLACE matches exactly once and only on the slice-20
// version of the doc.
const SLICE_20_ANCHOR =
  '### Execute the next task (sub-agent dispatch)\n' +
  '\n' +
  '**You no longer farm tasks to a Claude CLI subprocess.** Each ready task is dispatched ' +
  'across your `claude_sub_agent` specialists via the Claude Agent SDK\'s native `Task()` ' +
  'tool — multiple in parallel where the task spans concerns. Do NOT call the legacy ' +
  '`execute_epic_task` tool; it is no longer bound to you.';

const SLICE_23_REPLACEMENT =
  '### Execute the next task (vendor-conditional)\n' +
  '\n' +
  '**The execution surface depends on which model vendor you (the orchestrator) run on.** ' +
  'Look at the tools actually bound to you and follow the matching procedure below — only ' +
  'one applies at a time.\n' +
  '\n' +
  '- **Anthropic vendor** → `start_epic_task` is bound. Sub-agent dispatch flow.\n' +
  '- **OpenAI / Codex vendor** → `start_epic_task_codex` is bound (and optionally ' +
  '`plan_epic_task`). Single-session execute flow.\n' +
  '\n' +
  'Do NOT call the legacy `execute_epic_task` tool under either vendor; it is no longer ' +
  'bound. `complete_epic_task` is the shared lifecycle finalize for both procedures.\n' +
  '\n' +
  '#### Procedure A — Anthropic sub-agent dispatch\n' +
  '\n' +
  'Each ready task is dispatched across your `claude_sub_agent` specialists via the Claude ' +
  'Agent SDK\'s native `Task()` tool — multiple in parallel where the task spans concerns.';

// ─── Helper ───────────────────────────────────────────────────────────────

async function applyReplace(queryInterface, oldText, newText, now) {
  await queryInterface.sequelize.query(
    `UPDATE skills
       SET skill_text = REPLACE(skill_text, :oldText, :newText),
           updated_at = :now
     WHERE slug = :slug`,
    { replacements: { oldText, newText, now, slug: SKILL_SLUG } },
  );
}

// Append a new `#### Procedure B — Codex single-session execute` block
// right after the slice-20 Anthropic block ends. The slice-20 block ends
// with the "Common pitfalls" list whose final bullet is the unique
// "**Calling the legacy `execute_epic_task`.**" line — we anchor on it.
const ANTHROPIC_PITFALLS_TAIL =
  '- **Calling the legacy `execute_epic_task`.**';

const ANTHROPIC_PITFALLS_TAIL_PLUS_CODEX =
  '- **Calling the legacy `execute_epic_task`.**\n' +
  '\n' +
  '#### Procedure B — Codex single-session execute\n' +
  '\n' +
  'Codex\'s SDK has no parallel sub-agent equivalent — one Codex session is itself a full ' +
  'agent that plans + executes inside its own loop. Spawning N concurrent Codex sessions ' +
  'against one repo would race on the git index. So the codex-vendor flow is "optional ' +
  'plan, then execute, then finalize" — not fan-out.\n' +
  '\n' +
  'Procedure for each ready task:\n' +
  '\n' +
  '1. **(Optional, recommended for consequential tasks)** Call ' +
  '**`plan_epic_task`** with no arguments. It runs Codex on the next ready task with the ' +
  'sandbox pinned to read-only and asks for a structured Markdown plan (steps + files to ' +
  'modify + risks + validation). Codex cannot touch files in this mode — the sandbox layer ' +
  'refuses every write/exec. Use this BEFORE execution for migrations, user-visible ' +
  'changes, or anything you want the user to approve. Skip it for trivial edits where ' +
  'planning would be overkill.\n' +
  '2. **(Optional but recommended)** Surface the plan to the user in chat if the task is ' +
  'consequential. Wait for explicit approval (or revisions) before executing. Trivial tasks ' +
  'can skip this gate.\n' +
  '3. Call **`start_epic_task_codex({ plan? })`**. It auto-resolves the next ready task, ' +
  'syncs the stage branch, marks the task in_progress, snapshots HEAD for diff capture, ' +
  'then runs ONE Codex session with the sandbox in workspace-write mode. The session ' +
  'plans + executes + commits inside its own loop. When you supply `plan`, Codex treats ' +
  'it as the blueprint and follows it instead of re-deriving.\n' +
  '4. Codex returns a final summary (typically with a `## Files changed` section). You ' +
  'don\'t need to invoke any other tools mid-execution — `start_epic_task_codex` is a ' +
  'single blocking call that does the whole task end-to-end.\n' +
  '5. Call **`complete_epic_task`** with:\n' +
  '   - `summary`: lift this from Codex\'s final output (or write your own from the ' +
  '`## Files changed` section). Persists to the per-task summary file.\n' +
  '   - `status`: `"completed"` on success, `"failed"` (with mandatory `failureReason`) ' +
  'when Codex bailed mid-execution.\n' +
  '6. After `complete_epic_task` returns, the worker AUTO-ENQUEUES the next ready task — ' +
  'do NOT call `start_epic_task_codex` again from the same turn.\n' +
  '\n' +
  'Common pitfalls to avoid (Codex flow):\n' +
  '- **Calling `start_epic_task_codex` twice without `complete_epic_task` in between.** ' +
  'The lifecycle assumes one in-progress task per epic.\n' +
  '- **Calling `plan_epic_task` after `start_epic_task_codex`.** The plan tool is for ' +
  '*before* execution; running it after won\'t change anything in flight.\n' +
  '- **Trying to use `start_epic_task` (the Anthropic tool) on Codex.** It\'s not bound ' +
  'to you under the Codex vendor — only `start_epic_task_codex` is.\n' +
  '- **Trying to dispatch parallel `Task()` calls on Codex.** The SDK has no equivalent ' +
  '— that\'s an Anthropic-only mechanism.';

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    // 1. Replace the slice-20 "Execute the next task (sub-agent dispatch)"
    //    header phrase with the vendor-conditional wrapper + Procedure A
    //    sub-header. The Anthropic body that follows in the live skill
    //    text becomes the contents of Procedure A.
    await applyReplace(queryInterface, SLICE_20_ANCHOR, SLICE_23_REPLACEMENT, now);
    // 2. Append the Codex Procedure B right after the slice-20 pitfalls
    //    block tail.
    await applyReplace(
      queryInterface,
      ANTHROPIC_PITFALLS_TAIL,
      ANTHROPIC_PITFALLS_TAIL_PLUS_CODEX,
      now,
    );
  },

  async down(queryInterface) {
    const now = new Date();
    await applyReplace(
      queryInterface,
      ANTHROPIC_PITFALLS_TAIL_PLUS_CODEX,
      ANTHROPIC_PITFALLS_TAIL,
      now,
    );
    await applyReplace(queryInterface, SLICE_23_REPLACEMENT, SLICE_20_ANCHOR, now);
  },
};
