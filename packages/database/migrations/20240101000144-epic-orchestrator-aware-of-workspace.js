"use strict";

/**
 * Teach the `epic-orchestrator-sdk` skill that every new epic gets a
 * per-epic shared workspace folder, what its path looks like, and how
 * sub-agents are made aware of it.
 *
 * Pairs with migration 143 (which added `epic_tasks.workspace_path`) and
 * the runtime change in `epicTaskTools.ts` that:
 *   - surfaces the path in `start_epic_task`'s response under
 *     `## Epic shared workspace`, and
 *   - server-side wraps each sub-agent's `scope` with a header naming
 *     the folder (so sub-agents always see it without the orchestrator
 *     having to remember to mention it).
 *
 * The skill update inserts a new "## Per-epic shared workspace" section
 * between the sub-agent-roster section and the "## Phase 3" header. This
 * keeps the section visible to the orchestrator before it reads the
 * per-task loop, so it understands the concept by the time
 * `start_epic_task` first returns the workspace path.
 *
 * Idempotent: `REPLACE` is a no-op when the OLD substring is absent.
 * Only the SDK skill is touched (Codex skill doesn't surface the
 * workspace today; can be added separately if needed).
 *
 * @type {import('sequelize-cli').Migration}
 */

const TARGET_SLUG = "epic-orchestrator-sdk";

// Anchor on the seam between any preceding section and the Phase 3
// header — this seam is the same byte sequence in the freshly-seeded
// migration 140 text and after migrations 141 and 142 have run (none
// of them touched the Phase 3 header line). The new section is inserted
// BEFORE the Phase 3 header so the orchestrator sees the workspace
// concept while still in the planning chapter.

const OLD_SEAM = `---

## Phase 3: Execute & Review Tasks`;

const NEW_SEAM = `---

## Per-epic shared workspace

Every new epic gets its OWN folder on disk, created automatically at
\`create_epic_plan\` time. Layout:

    <your workspacePath>/epics/<epic-id>/

The path is stored on \`epic_tasks.workspace_path\` and is **stable across
thread rotations** — sub-agents dispatched in task N+1 can read files
that sub-agents in task N wrote, even if the conversation thread has
been summarized into a fresh thread in between.

What the folder is for:
- Non-repo deliverables produced by sub-agents (research notes, scratch
  markdown, intermediate artifacts the next task may consume, plan-stage
  outputs, design sketches, …).
- Cross-task continuity: when an earlier task in this epic produced a
  file the current sub-agent needs, that file lives here.

What the folder is NOT for:
- **Code edits.** Those still go to the repository working directory
  (the cwd \`start_epic_task\` returns under \`## Repository\`). Anything
  written inside the repo cwd ends up in the PR; anything written here
  does not.

How sub-agents learn about it:
- \`start_epic_task\` returns the path under \`## Epic shared workspace\`
  in its response body — you'll see it on every call when the epic has
  a workspace configured.
- The runtime ALSO server-side prepends a "## Epic shared workspace
  (read + write)" header to every sub-agent's \`scope\` before dispatch,
  so the sub-agent always sees the absolute path verbatim — you don't
  have to remember to include it in each scope. Pasting the
  \`Task(...)\` calls verbatim from the dispatch plan is sufficient.

Pre-existing epics (created before this column was added) have
\`workspace_path = NULL\` — \`start_epic_task\` simply omits the
\`## Epic shared workspace\` block on those. New epics always get one
unless your orchestrator agent has no \`workspace_path\` configured at
all (rare; system-only agents).

---

## Phase 3: Execute & Review Tasks`;

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
    await applyReplace(queryInterface, OLD_SEAM, NEW_SEAM, now);
  },

  async down(queryInterface) {
    const now = new Date();
    await applyReplace(queryInterface, NEW_SEAM, OLD_SEAM, now);
  },
};
