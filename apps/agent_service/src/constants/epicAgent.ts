/**
 * Definition string for per-org Epic Orchestrator primary agents.
 *
 * Each organization gets its own Epic Orchestrator seeded at signup — there
 * is no global singleton. Resolve the concrete agent by looking up the
 * caller's organizationId and filtering Agent by `type = "primary"` and
 * `definition = EPIC_ORCHESTRATOR_DEFINITION`.
 */
export const EPIC_ORCHESTRATOR_DEFINITION = "Epic Task Orchestrator";
