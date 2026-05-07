"use strict";

/**
 * Teach the orchestrator about the "one stage = one repo" rule and the new
 * per-stage `repositoryId` field on `create_epic_plan`.
 *
 * Background — wrong-repo bug (StocksScanner / grahamy-agents incident):
 * before this change, `create_epic_plan` only accepted `repositoryIds` at
 * the EPIC level. The runtime had to guess which repo each stage targeted
 * and used "first epic-level repo with a localPath" as the fallback. On
 * multi-repo epics that picks a coin-flip — half of the user's runs were
 * executing tasks against the wrong repository, with no error and a
 * silently wrong working directory.
 *
 * The runtime fix moved the cwd resolution to `stage.repository.localPath`
 * (always) and added optional `repositoryId` per stage in the
 * `create_epic_plan` schema. Multi-repo epics now require an explicit
 * `repositoryId` on every stage; single-repo epics auto-fill from the only
 * choice.
 *
 * The skill change here teaches the model the corresponding rule:
 *   - one stage = one repository (because the stage owns the PR fields)
 *   - if a unit of work spans repos, plan one stage per repo
 *   - pass `repositoryId` per stage when the epic has more than one repo
 *
 * Scope: applies to BOTH vendor variants (`epic-orchestrator-sdk` and
 * `epic-orchestrator-codex`) — the SHARED_HEADER text in migration 140
 * contains the same `### Stages` and `### Create the epic` blocks in both
 * skill rows, so the same REPLACE pair updates both at once.
 *
 * Idempotent: `REPLACE` is a no-op when the OLD substring is absent (e.g.
 * after the migration has already been applied), so re-runs and partial
 * states are safe.
 *
 * @type {import('sequelize-cli').Migration}
 */

const TARGET_SLUGS = ["epic-orchestrator-sdk", "epic-orchestrator-codex"];

// ─── 1. Tighten the `### Stages` block ─────────────────────────────────────

// Anchor on the full block as written by migration 140's SHARED_HEADER.
// The OLD string MUST match the live skill_text byte-for-byte (line wraps,
// punctuation, em-dashes) for the REPLACE to fire.
const OLD_STAGES_BLOCK = `### Stages
- Each stage maps to **one pull request**.
- Stages are executed sequentially (stage N must be PR-approved before
  stage N+1 begins).
- Group related changes that should be reviewed together into the same
  stage.
- Examples: "Database migrations", "Backend API", "Frontend UI",
  "Tests & docs".`;

const NEW_STAGES_BLOCK = `### Stages
- Each stage maps to **one pull request**.
- **Each stage targets exactly ONE repository.** The stage owns the PR
  fields (\`prNumber\`, \`prUrl\`, \`branchName\`, \`baseCommitSha\`), so a
  single stage cannot span two repos. **Every task inside a stage runs
  with that repository as its working directory** — the runtime resolves
  \`cwd\` from \`stage.repository.localPath\`.
- **If a unit of work crosses repositories, plan one stage per repo** —
  e.g. an investigation that needs to read both \`grahamy-agents\` and
  \`schedassistant\` becomes TWO plan-stages ("Analyze grahamy-agents
  changes" + "Analyze schedassistant changes"), not one stage with two
  tasks. Same rule for code-change work that touches a backend repo and
  a frontend repo: two stages, one per repo, each producing its own PR.
- Stages are executed sequentially (stage N must be PR-approved before
  stage N+1 begins).
- Group related changes that should be reviewed together into the same
  stage.
- Examples: "Database migrations", "Backend API", "Frontend UI",
  "Tests & docs".`;

// ─── 2. Update the `### Create the epic` block ─────────────────────────────

// Anchor: the full bullet list. Same byte-for-byte rule.
const OLD_CREATE_BLOCK = `### Create the epic
Call \`create_epic_plan\` with:
- \`title\` — concise name for the epic
- \`description\` — the full user request in your own words
- \`projectId\` — from Phase 1
- \`repositoryIds\` — from Phase 1
- \`stages\` — the breakdown above, with tasks and sort orders.`;

const NEW_CREATE_BLOCK = `### Create the epic
Call \`create_epic_plan\` with:
- \`title\` — concise name for the epic
- \`description\` — the full user request in your own words
- \`projectId\` — from Phase 1
- \`repositoryIds\` — from Phase 1 (every repo any stage in this epic
  will touch)
- \`stages\` — the breakdown above, with tasks and sort orders. **Each
  stage object MUST include \`repositoryId\` whenever the epic spans
  more than one repository** (i.e. when \`repositoryIds.length > 1\`).
  The value must be one of the IDs you passed in \`repositoryIds\`. The
  runtime uses it to (a) check out the stage's feature branch on the
  right repo, (b) open the PR against that repo, and (c) set the
  working directory for every task in the stage. For single-repo epics
  (\`repositoryIds.length === 1\`) you may omit it — the runtime auto-
  fills from the only choice. **Omitting it on a multi-repo epic is
  rejected at create time** and the epic is not persisted, so always
  set it when in doubt.`;

// ─── Helper ───────────────────────────────────────────────────────────────

async function applyReplaceAcrossSlugs(queryInterface, oldText, newText, now) {
  for (const slug of TARGET_SLUGS) {
    await queryInterface.sequelize.query(
      `UPDATE skills
         SET skill_text = REPLACE(skill_text, :oldText, :newText),
             updated_at = :now
       WHERE slug = :slug`,
      { replacements: { oldText, newText, now, slug } },
    );
  }
}

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    await applyReplaceAcrossSlugs(queryInterface, OLD_STAGES_BLOCK, NEW_STAGES_BLOCK, now);
    await applyReplaceAcrossSlugs(queryInterface, OLD_CREATE_BLOCK, NEW_CREATE_BLOCK, now);
  },

  async down(queryInterface) {
    const now = new Date();
    await applyReplaceAcrossSlugs(queryInterface, NEW_CREATE_BLOCK, OLD_CREATE_BLOCK, now);
    await applyReplaceAcrossSlugs(queryInterface, NEW_STAGES_BLOCK, OLD_STAGES_BLOCK, now);
  },
};
