/**
 * Shared prompt for Claude CLI (`claude -p`) when generating `repository.architecture_overview`.
 * Used by admin "generate architecture" and by epic-time refresh on default branch.
 */

/** Safety cap when persisting to DB (PostgreSQL TEXT; avoids runaway outputs). */
export const MAX_ARCHITECTURE_OVERVIEW_STORE_CHARS = 1_000_000;

/**
 * @param currentOverview - Existing stored text, or "(none)".
 */
export function buildArchitectureOverviewPrompt(currentOverview: string): string {
  return (
    "Analyze this repository's on-disk structure and produce a COMPREHENSIVE architecture document " +
    "so that a developer or AI agent understands the repo at the folder level — not a shallow summary, " +
    "but also not an exhaustive per-file inventory.\n\n" +

    "### Mandatory — full folder-level coverage\n" +
    "- Enumerate **every meaningful directory** using a directory tree with **full depth at the folder level**. " +
    "Document folders, not individual files. For each folder, briefly describe its purpose/responsibility.\n" +
    "- Exclude only obvious noise: node_modules, .git, dist, build, out, coverage, .next, __pycache__, .venv, " +
    "target (Rust), .turbo, .cache, and similar dependency/build outputs. Do **not** omit real app source folders to save space.\n" +
    "- If the tree is very large, still complete it by package/area (e.g. full folder tree per top-level app) — " +
    "avoid \"...\" or \"and similar\" where specific folders matter.\n" +
    "- Do NOT list every file within a folder. Instead, summarize what kinds of files live there and what the folder is responsible for.\n\n" +

    "### Then — narrative (after the tree)\n" +
    "- Major components and responsibilities (backend, frontend, workers, etc.).\n" +
    "- Patterns (MVC, monorepo, queues, etc.) and primary entry points.\n" +
    "- Key infrastructure (DB, queues, external APIs) as reflected in the tree.\n\n" +

    "### Rules\n" +
    "- Be factual — describe only what exists in this working tree.\n" +
    "- Do **not** produce a short depth-2 overview; that is explicitly insufficient.\n" +
    "- Be exhaustive at the **folder** level; do not enumerate every file. " +
    "If you must trim, shorten prose after the tree, not the folder listing.\n\n" +

    "Current stored overview (may be outdated — replace with an updated full document):\n" +
    currentOverview +
    "\n\n" +
    "Output ONLY the updated architecture document — no preamble like \"Here is\".\n" +
    "Markdown is allowed (headings, fenced blocks for trees)."
  );
}
