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
  "feature_rules",
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
  "feature_rules",
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
  /\bfeature_rules\b/gi,
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

  if (cleaned) {
    warnings.push("MOAT guard removed or redacted internal-only fields.");
  }

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
  return FORBIDDEN_KEY_PARTS.some((part) => lower.includes(part));
}

