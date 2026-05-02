"use strict";

/**
 * Slice 20 — switches the Epic Task Workflow skill from CLI execution
 * to the new model-driven sub-agent dispatch.
 *
 * The orchestrator no longer farms each task to a Claude CLI subprocess
 * via `execute_epic_task`. Instead it:
 *   1. Calls `start_epic_task` to begin the next ready task (auto-resolves
 *      epic + task, syncs the stage branch, marks in_progress).
 *   2. Decomposes the task into per-concern slices (frontend / backend /
 *      DB / docs / etc.).
 *   3. Invokes `Task("<sub-agent-slug>", "<scoped instruction>")` for
 *      each slice IN PARALLEL — multiple `Task()` calls in a single
 *      assistant message run concurrently inside the Claude Agent SDK.
 *   4. Aggregates the sub-agent outputs.
 *   5. Calls `complete_epic_task` with the aggregated summary + status,
 *      which captures the git diff, commits leftover changes, marks the
 *      task completed/failed, and emits the EPIC_CONTINUATION marker so
 *      the worker auto-enqueues the next task.
 *
 * The change set inside the skill text:
 *   - Updates the "Local Repository Workflow" section so it stops
 *     describing the Claude CLI as the executor and instead describes
 *     `claude_sub_agent` rows + `Task()` dispatch.
 *   - Replaces the Phase 3 "Execute the next task" subsection with
 *     concrete instructions for per-concern decomposition and parallel
 *     `Task()` invocation, plus the new tool names.
 *   - Adds a "Plan stages for parallelism" reminder to Phase 2.
 *
 * Idempotent: each REPLACE substitutes a verbatim anchor for new text;
 * a re-run is a no-op. The migration's `down` reverses the same
 * substitutions.
 *
 * @type {import('sequelize-cli').Migration}
 */

const SKILL_SLUG = "epic-task-workflow";

// ─── 1. Local Repository Workflow header — replace the CLI-centric language ─

const OLD_LOCAL_REPO_BLOCK = `## Important: Local Repository Workflow

All repositories are **locally cloned** on this machine. The executor (Claude CLI) runs
commands, edits files, and commits **locally** using the repo's \`localPath\`.
- Do NOT use GitHub MCP servers, remote APIs, or any remote repository access.
- All git operations (diff, commit, push, branch) happen via the local git CLI.
- The working directory for each task is resolved from the repository's \`localPath\` field.
- Architecture context (project overview, repo structure, tech stack) is automatically
  injected into the executor's system prompt from the project and repository records.`;

const NEW_LOCAL_REPO_BLOCK = `## Important: Local Repository Workflow

All repositories are **locally cloned** on this machine. The executors are your
**Claude sub-agents** — \`claude_sub_agent\` rows attached to you by the admin
(see them via \`list_claude_sub_agents\`). They run inline inside your Claude
Agent SDK session, edit files, and commit **locally** using the repo's
\`localPath\`. You orchestrate them via the SDK's native
\`Task("<sub-agent-slug>", "<scoped instruction>")\` tool.
- Do NOT use GitHub MCP servers, remote APIs, or any remote repository access.
- All git operations (diff, commit, push, branch) happen via the local git CLI.
- The working directory for each task is resolved from the repository's \`localPath\` field.
- Architecture context (project overview, repo structure, tech stack) is automatically
  injected into each sub-agent's prompt from the project and repository records.
- Multiple sub-agents can work on the same task in parallel — emit all your
  \`Task()\` calls in a single assistant message and the SDK runs them concurrently.`;

// ─── 2. Phase 2: append a "Plan stages for parallelism" subsection ─────

const OLD_PHASE2_RULE_3_ANCHOR =
  '3. **Never skip the planning phase, and NEVER call `create_epic_plan` until the user has explicitly approved the proposed plan in chat.** Even for "simple" requests, present the stages and tasks first and wait for the user\'s confirmation. Epics cannot be edited after creation — a wrong plan forces the user to cancel and rebuild from scratch.';

const NEW_PHASE2_RULE_3_PLUS_PARALLELISM =
  '3. **Never skip the planning phase, and NEVER call `create_epic_plan` until the user has explicitly approved the proposed plan in chat.** Even for "simple" requests, present the stages and tasks first and wait for the user\'s confirmation. Epics cannot be edited after creation — a wrong plan forces the user to cancel and rebuild from scratch.\n' +
  '4. **Plan tasks for sub-agent parallelism.** Before listing tasks under each stage, scan your `list_claude_sub_agents` roster and ask: "if this task touches multiple concerns (frontend + backend + DB + docs), can each concern be assigned to ONE specialist sub-agent?" If yes, write the task description so it explicitly enumerates the concerns — they become your slice boundaries when you dispatch parallel `Task()` calls during execution. A typical full-stack feature task should fan out to 2–4 specialists; a pure frontend tweak might stay single-specialist. **Avoid bundling concerns into one giant single-specialist task** — that wastes the parallelism the SDK gives you and produces a slower, narrower edit.';

// ─── 3. Phase 3 execution subsection — replace the CLI flow with sub-agent flow ─

// We anchor on the legacy heading "### Execute the next task" plus the
// trailing "execute_epic_task" tool name reference. The 049 seed shipped
// a heading by that name; later migrations didn't rename it. If a future
// migration renames the heading, this REPLACE becomes a no-op (matches
// nothing) and we just need a follow-up patch — preferable to silent
// double-substitution.
const OLD_EXECUTE_TASK_BLOCK = '### Execute the next task\nCall the \`execute_epic_task\` tool';

const NEW_EXECUTE_TASK_BLOCK =
  '### Execute the next task (sub-agent dispatch)\n' +
  '\n' +
  '**You no longer farm tasks to a Claude CLI subprocess.** Each ready task is dispatched ' +
  'across your `claude_sub_agent` specialists via the Claude Agent SDK\'s native `Task()` ' +
  'tool — multiple in parallel where the task spans concerns. Do NOT call the legacy ' +
  '`execute_epic_task` tool; it is no longer bound to you.\n' +
  '\n' +
  'Procedure for each ready task:\n' +
  '\n' +
  '1. Call **`list_claude_sub_agents`** if you haven\'t this conversation. The slugs you get ' +
  'back are what you DECLARE in `start_epic_task` and what you pass to `Task()` below.\n' +
  '2. **Decompose the task into per-concern slices** BEFORE calling `start_epic_task`:\n' +
  '   - Frontend changes (React / view layer) → frontend specialist sub-agent.\n' +
  '   - Backend / REST API changes (Express / controllers / services) → backend specialist.\n' +
  '   - DB schema / migrations / queries → DB specialist.\n' +
  '   - Docs / README / changelog → docs specialist.\n' +
  '   - … etc., based on which sub-agents are actually attached to you.\n' +
  '3. Call **`start_epic_task({ assignments: [...] })`** declaring your slice plan up front. ' +
  'Each `assignments` entry is `{ subagentSlug, scope }` — one per sub-agent you intend to ' +
  'dispatch. The tool **validates every slug is a `claude_sub_agent` attached to you** before ' +
  'mutating any state; if you pass a system-agent slug, a peer\'s slug, or an unknown slug, ' +
  'the call fails without marking anything in_progress and you can retry. On success it ' +
  'syncs the stage branch, marks the task in_progress, and echoes back the exact `Task()` ' +
  'calls you should now emit.\n' +
  '4. **Dispatch in parallel.** In a SINGLE assistant message, emit one ' +
  '`Task("<slug>", "<scoped instruction>")` per slice from the echo. The SDK runs them ' +
  'concurrently inside your session and returns each result inline. Each scope must:\n' +
  '   - Name the exact files / directories the sub-agent should look at and change.\n' +
  '   - Be self-contained: sub-agents do NOT see each other\'s outputs, only your ' +
  'instruction. If concern B depends on concern A\'s shape, either fold them into one ' +
  'slice or run them sequentially across two `start_epic_task` cycles.\n' +
  '   - Stay strictly within the slice — don\'t ask the frontend specialist to touch DB ' +
  'migrations.\n' +
  '5. **Wait for ALL `Task()` results to return** in your tool-loop before moving on. ' +
  'Each result includes that sub-agent\'s `## Files changed` section.\n' +
  '6. Call **`complete_epic_task`** with:\n' +
  '   - `summary`: a Markdown aggregation of what each sub-agent did + per-slice file ' +
  'lists + the overall outcome. The orchestrator persists this to the per-task summary ' +
  'file so `send_file_to_user` can surface it later.\n' +
  '   - `status`: `"completed"` when the slices reconciled cleanly, or `"failed"` (with a ' +
  'mandatory `failureReason`) when a critical sub-agent could not finish.\n' +
  '7. After `complete_epic_task` returns, the worker AUTO-ENQUEUES the next ready task — ' +
  'do NOT call `start_epic_task` again from the same turn. Wait for the worker\'s ' +
  'continuation invocation.\n' +
  '\n' +
  'Common pitfalls to avoid:\n' +
  '- **Calling `start_epic_task` without `assignments`** — the parameter is required. The ' +
  'tool needs your slice plan to validate sub-agent ownership and to echo the dispatch.\n' +
  '- **Putting a system-agent slug in `assignments`.** System agents are reachable only via ' +
  '`delegate_to_deep_agent` (different runtime). The validator will reject the call.\n' +
  '- **Sequential `Task()` calls when parallel works.** If you emit them across multiple ' +
  'assistant messages they serialize. Put them all in one message.\n' +
  '- **Calling `start_epic_task` twice without `complete_epic_task` in between.** The ' +
  'second call will refuse — there can only be one in-progress task per epic.\n' +
  '- **Calling the legacy `execute_epic_task`.**';

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

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    await applyReplace(queryInterface, OLD_LOCAL_REPO_BLOCK, NEW_LOCAL_REPO_BLOCK, now);
    await applyReplace(queryInterface, OLD_PHASE2_RULE_3_ANCHOR, NEW_PHASE2_RULE_3_PLUS_PARALLELISM, now);
    await applyReplace(queryInterface, OLD_EXECUTE_TASK_BLOCK, NEW_EXECUTE_TASK_BLOCK, now);
  },

  async down(queryInterface) {
    const now = new Date();
    await applyReplace(queryInterface, NEW_EXECUTE_TASK_BLOCK, OLD_EXECUTE_TASK_BLOCK, now);
    await applyReplace(queryInterface, NEW_PHASE2_RULE_3_PLUS_PARALLELISM, OLD_PHASE2_RULE_3_ANCHOR, now);
    await applyReplace(queryInterface, NEW_LOCAL_REPO_BLOCK, OLD_LOCAL_REPO_BLOCK, now);
  },
};
