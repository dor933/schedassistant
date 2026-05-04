export const FORBIDDEN_PATTERNS = [
  "edge_id",
  "hypothesis_id",
  "signal_sql",
  "run_id",
  "pipeline_run_id",
  "raw_wr",
  "raw_win_rate",
  "raw_alpha",
  "backtest_details",
  "internal_score",
  "setup_score",
  "score_formula",
  "scoring_formula",
  "divergence_score",
  "divergence_formula",
  "sector_delta_formula",
  "conviction_formula",
  "momentum_formula",
  "feature_rules",
  "raw_sql",
  "raw_rows",
  "analog_rows",
  "raw_analog_rows",
  "path_rows",
  "gate_name",
  "internal_threshold",
  "threshold_rule",
  "query text",
] as const;

const FORBIDDEN_KEY_PARTS = [
  "edge_id",
  "hypothesis_id",
  "signal_sql",
  "pipeline_run_id",
  "raw_wr",
  "raw_win_rate",
  "raw_alpha",
  "backtest_details",
  "internal_score",
  "setup_score",
  "score_formula",
  "scoring_formula",
  "divergence_score",
  "divergence_formula",
  "sector_delta_formula",
  "conviction_formula",
  "momentum_formula",
  "feature_rules",
  "raw_sql",
  "raw_rows",
  "analog_rows",
  "raw_analog_rows",
  "path_rows",
  "gate_name",
  "internal_threshold",
  "threshold_rule",
];

const FORBIDDEN_TEXT_REGEXES = [
  /\bedge_id\b/gi,
  /\bhypothesis_id\b/gi,
  /\bsignal_sql\b/gi,
  /\bpipeline_run_id\b/gi,
  /\braw_wr\b/gi,
  /\braw_win_rate\b/gi,
  /\braw_alpha\b/gi,
  /\bbacktest_details\b/gi,
  /\binternal_score\b/gi,
  /\bsetup_score\b/gi,
  /\bscore_formula\b/gi,
  /\bscoring_formula\b/gi,
  /\bdivergence_score(?:_pct)?\b/gi,
  /\bdivergenceScorePct\b/g,
  /\bdivergence_formula\b/gi,
  /\bsector_delta_formula\b/gi,
  /\bconviction_formula\b/gi,
  /\bmomentum_formula\b/gi,
  /\bfeature_rules\b/gi,
  /\braw_sql\b/gi,
  /\braw_rows\b/gi,
  /\banalog_rows\b/gi,
  /\braw_analog_rows\b/gi,
  /\bpath_rows\b/gi,
  /\bgate(?:_name|s)?\b/gi,
  /\binternal_threshold\b/gi,
  /\bthreshold_rule\b/gi,
  /\bsql\b/gi,
  /\bquery text\b/gi,
  /\bpipeline implementation details\b/gi,
];

export type MoatGuardResult<T> = {
  value: T;
  result: "clean" | "cleaned" | "failed";
  warnings: string[];
};

export function runMoatGuard<T>(value: T): MoatGuardResult<T> {
  let cleaned = false;
  const warnings: string[] = [];

  const scrubbed = scrub(value, () => {
    cleaned = true;
  }) as T;

  // Note: deliberately do NOT push a user-facing warning when scrubbing
  // happens. That detail is internal diagnostics — the `result: "cleaned"`
  // discriminator below is preserved on the response (as
  // `meta.moatGuardResult`) for telemetry / observability, and the graph
  // logs `moatGuardResult` on every turn. Surfacing it as a "Warnings"
  // bullet to end users was confusing without adding value.

  return {
    value: scrubbed,
    result: cleaned ? "cleaned" : "clean",
    warnings,
  };
}

function scrub(value: unknown, markCleaned: () => void): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => scrub(item, markCleaned));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (isForbiddenKey(key)) {
        markCleaned();
        continue;
      }
      out[key] = scrub(item, markCleaned);
    }
    return out;
  }
  if (typeof value === "string") {
    let next = value;
    for (const pattern of FORBIDDEN_TEXT_REGEXES) {
      next = next.replace(pattern, () => {
        markCleaned();
        return "restricted internal detail";
      });
    }
    return next;
  }
  return value;
}

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower === "run_id" || lower === "runid") return true;
  if (lower === "gate" || lower === "gates" || lower === "gate_name") return true;
  if (lower === "divergencescorepct" || lower === "divergenceformula") return true;
  if (lower === "sectordeltaformula" || lower === "convictionformula") return true;
  if (lower === "scoringformula" || lower === "momentumformula") return true;
  if (lower.endsWith("_gate") || lower.startsWith("gate_")) return true;
  return FORBIDDEN_KEY_PARTS.some((part) => lower.includes(part));
}
