const DB_SUFFIX = "." + "db";

export const PIPELINE_OVERLAY_FORBIDDEN_KEYS = [
  "edge_id",
  "edgeid",
  "hypothesis_id",
  "hypothesisid",
  "gates",
  "gate_name",
  "gatename",
  "threshold",
  "thresholds",
  "feature_rules",
  "featurerules",
  "raw_sql",
  "rawsql",
  "sql",
  "raw_rows",
  "rawrows",
  "rows",
  "table",
  "tables",
  "anchors",
  "derivation",
  "run_id",
  "runid",
  "pipeline_run_id",
  "pipelinerunid",
  "pipeline_state",
  "pipelinestate",
  "sections",
  "claims",
  "manifest",
  "pit",
  "pipeline_evidence",
  "pipelineevidence",
] as const;

export const PIPELINE_OVERLAY_FORBIDDEN_TERMS = [
  "lifecycle audit",
  "sqlite",
  "grahamy_discovery" + DB_SUFFIX,
  "grahamy_ops" + DB_SUFFIX,
  "md_hypotheses",
  "md_event_returns",
  "md_sentinel_tracking",
  "md_daily_signals",
  "md_convergence_signals",
  "md_lifecycle_events",
  "md_run_manifest",
  "stop-loss",
  "sizing",
  "buy",
  "sell",
  "recommendation",
] as const;

const FORBIDDEN_KEY_SET = new Set<string>(
  PIPELINE_OVERLAY_FORBIDDEN_KEYS.map(normalizeKey),
);

export function isPipelineOverlayForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEY_SET.has(normalizeKey(key));
}

export function containsPipelineOverlayForbiddenTerm(value: string): boolean {
  const normalized = value.toLowerCase();
  return PIPELINE_OVERLAY_FORBIDDEN_TERMS.some((term) =>
    normalized.includes(term.toLowerCase()),
  );
}

function normalizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}
