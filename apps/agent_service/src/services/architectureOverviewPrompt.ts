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
    "so that a developer or AI agent understands the repo down to individual files — not a shallow summary.\n\n" +

    "### Mandatory — full file-level coverage\n" +
    "- Enumerate **every meaningful source file** using a directory tree or flat path list with **full depth** " +
    "(not depth-2, not \"top-level only\"). Substantive code, configs, tests, migrations, scripts, and docs must appear.\n" +
    "- Exclude only obvious noise: node_modules, .git, dist, build, out, coverage, .next, __pycache__, .venv, " +
    "target (Rust), .turbo, .cache, and similar dependency/build outputs. Do **not** omit real app source to save space.\n" +
    "- If the tree is very large, still complete it by package/area (e.g. full tree per top-level app folder) — " +
    "avoid \"...\" or \"and similar\" where specific paths matter.\n" +
    "- You may start from `git ls-files` mentally or list paths in a clear tree; accuracy matters more than brevity.\n\n" +

    "### Then — narrative (after the tree)\n" +
    "- Major components and responsibilities (backend, frontend, workers, etc.).\n" +
    "- Patterns (MVC, monorepo, queues, etc.) and primary entry points.\n" +
    "- Key infrastructure (DB, queues, external APIs) as reflected in the tree.\n\n" +

    "### Rules\n" +
    "- Be factual — describe only what exists in this working tree.\n" +
    "- Do **not** produce a short depth-2 overview; that is explicitly insufficient.\n" +
    "- Be exhaustive in the file inventory; do not artificially cap length for the tree. " +
    "If you must trim, shorten prose after the tree, not the path listing.\n\n" +

    "Current stored overview (may be outdated — replace with an updated full document):\n" +
    currentOverview +
    "\n\n" +
    "Output ONLY the updated architecture document — no preamble like \"Here is\".\n" +
    "Markdown is allowed (headings, fenced blocks for trees)."
  );
}
