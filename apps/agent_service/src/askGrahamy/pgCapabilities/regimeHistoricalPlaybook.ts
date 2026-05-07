import { logger } from "../../logger";
import { numberValue, stringValue } from "../snapshotClient";
import type {
  RegimeHistoricalPlaybookRiskView,
  RegimeHistoricalPlaybookRole,
  RegimeHistoricalPlaybookRowView,
  RegimeHistoricalPlaybookView,
} from "../types";
import { assessCapabilityFreshness } from "./freshnessGuard";
import { runPgCapabilityQuery } from "./queryClient";
import type {
  CapabilityFreshness,
  PgCapabilityRunInput,
  PgCapabilityRunResult,
  RegimeHistoricalPlaybookRow,
} from "./types";

const VIEW_SCHEMA_VERSION = 1;
const DEFAULT_MAX_ROWS = 10;
const MAX_ROWS_CAP = 20;
const NO_MEANINGFUL_ROWS_WARNING =
  "No meaningful historical regime leaders or laggards were found for the current regime.";

type RegimePlaybookEmphasis = "leaders" | "laggards" | "risks" | "general";

export type RegimeHistoricalPlaybookOptions = {
  queryRunner?: (
    replacements: Record<string, unknown>,
  ) => Promise<RegimeHistoricalPlaybookRow[]>;
  maxRows?: number;
  now?: Date;
};

export function regimeHistoricalPlaybookCacheKeyParams(
  input: PgCapabilityRunInput,
): { emphasis: RegimePlaybookEmphasis } {
  return { emphasis: inferEmphasis(input.message) };
}

export async function buildRegimeHistoricalPlaybookView(
  input: PgCapabilityRunInput,
  options: RegimeHistoricalPlaybookOptions = {},
): Promise<PgCapabilityRunResult> {
  const emphasis = inferEmphasis(input.message);
  const maxRows = clampMaxRows(options.maxRows ?? DEFAULT_MAX_ROWS);

  if (!options.queryRunner && !isExternalPgConfigured()) {
    return {
      views: {
        regimeHistoricalPlaybookView: unavailableView([
          "External PG warehouse is not configured for regime historical playbook queries.",
        ]),
      },
      warnings: [],
    };
  }

  try {
    const rows = await (options.queryRunner ?? defaultQueryRunner)({
      MAX_ROWS: maxRows,
      ROLE_FILTER: emphasis,
    });
    const view = rowsToView(rows, options.now);
    return { views: { regimeHistoricalPlaybookView: view }, warnings: [] };
  } catch (err) {
    const message = "Regime historical playbook query failed.";
    logger.warn("Ask Grahamy PG capability failed", {
      capability: "market_regime_historical_playbook",
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      views: {
        regimeHistoricalPlaybookView: unavailableView([message]),
      },
      warnings: [message],
    };
  }
}

function defaultQueryRunner(
  replacements: Record<string, unknown>,
): Promise<RegimeHistoricalPlaybookRow[]> {
  return runPgCapabilityQuery<RegimeHistoricalPlaybookRow>(
    "query_regime_historical_playbook",
    replacements,
  );
}

function rowsToView(
  rows: RegimeHistoricalPlaybookRow[],
  now?: Date,
): RegimeHistoricalPlaybookView {
  if (!rows.length) {
    return unavailableView([
      "Current regime or historical regime sector rows are unavailable.",
    ]);
  }

  const first = rows[0];
  const regime = stringValue(first.regime);
  const asOfDate = dateStringValue(first.as_of_date);
  if (!regime || !asOfDate) {
    return unavailableView([
      "Current regime could not be resolved from the PG warehouse.",
    ]);
  }

  const publicRows = rows
    .filter((row) => boolValue(row.include_in_public))
    .map((row) => rowToPublicRow(row, regime))
    .filter((row): row is RegimeHistoricalPlaybookRowView => !!row)
    .map((row, index) => ({ ...row, rank: index + 1 }));
  const risks = buildRisks(first);
  const freshnessAssessment = buildFreshness(first, asOfDate, now);
  const freshness = freshnessAssessment.publicFreshness;
  if (freshnessAssessment.decision === "unavailable") {
    return unavailableView(
      [freshness.warning ?? "Regime historical playbook data is stale."],
      freshness,
      regime,
      asOfDate,
    );
  }

  const warnings: string[] = [];
  if (!publicRows.length) {
    warnings.push(NO_MEANINGFUL_ROWS_WARNING);
  }
  if (!risks.length) {
    warnings.push(
      "Public bucketed macro risk context is unavailable for the current regime view.",
    );
  }
  if (freshness.state === "stale") {
    warnings.push(
      freshness.warning ??
        "This regime historical playbook uses stale data and should be treated as a snapshot.",
    );
  } else if (freshness.state === "unknown" && freshness.warning) {
    warnings.push(freshness.warning);
  }

  return {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state: risks.length ? "complete" : "partial",
    source: "pg_regime_history",
    regime,
    asOfDate,
    rows: publicRows,
    risks,
    summaryBullets: buildSummaryBullets(regime, publicRows, risks),
    freshness,
    warnings,
  };
}

function rowToPublicRow(
  row: RegimeHistoricalPlaybookRow,
  regime: string,
): RegimeHistoricalPlaybookRowView | null {
  const sector = stringValue(row.sector);
  const rank = integerValue(row.rank);
  const role = roleValue(row.role);
  if (!sector || rank == null || !role) return null;

  const publicRow = compactObject({
    sector,
    rank,
    role,
    hitRatePct: roundNumber(row.hit_rate_pct, 1),
    medianForwardReturnPct: roundNumber(row.median_forward_return_pct, 2),
    evidenceStrength: stringValue(row.evidence_strength),
  });

  return {
    ...publicRow,
    interpretationBullets: buildInterpretationBullets(publicRow, regime),
  };
}

function buildInterpretationBullets(
  row: Omit<RegimeHistoricalPlaybookRowView, "interpretationBullets">,
  regime: string,
): string[] {
  const bullets: string[] = [];
  if (row.role === "leader") {
    bullets.push(
      `${row.sector} has historically screened among stronger sectors in ${regime} regimes.`,
    );
  } else if (row.role === "laggard") {
    bullets.push(
      `${row.sector} has historically screened among weaker sectors in ${regime} regimes.`,
    );
  } else {
    bullets.push(
      `${row.sector} has a mixed historical profile in ${regime} regimes.`,
    );
  }
  if (row.hitRatePct != null) {
    bullets.push("Historical positive-return hit-rate evidence is available.");
  }
  if (row.medianForwardReturnPct != null) {
    bullets.push("Historical median forward-return evidence is available.");
  }
  if (row.evidenceStrength) {
    bullets.push(`Sample adequacy is ${row.evidenceStrength}.`);
  }
  return bullets.slice(0, 4);
}

function buildRisks(
  row: RegimeHistoricalPlaybookRow,
): RegimeHistoricalPlaybookRiskView[] {
  const risks: RegimeHistoricalPlaybookRiskView[] = [];
  addRisk(risks, {
    riskLabel: "Volatility backdrop",
    riskBucket: stringValue(row.vix_risk_bucket),
    interpretations: {
      LOW: "Volatility backdrop is subdued in the latest public bucket.",
      MODERATE: "Volatility backdrop is moderate in the latest public bucket.",
      ELEVATED: "Volatility backdrop is elevated in the latest public bucket.",
      STRESSED: "Volatility backdrop is stressed in the latest public bucket.",
    },
  });
  addRisk(risks, {
    riskLabel: "Market breadth",
    riskBucket: stringValue(row.breadth_risk_bucket),
    interpretations: {
      BROAD: "Breadth is broad in the latest public bucket.",
      MIXED: "Breadth is mixed in the latest public bucket.",
      NARROW: "Breadth is narrow in the latest public bucket.",
    },
  });
  addRisk(risks, {
    riskLabel: "Sector dispersion",
    riskBucket: stringValue(row.dispersion_risk_bucket),
    interpretations: {
      NORMAL: "Sector dispersion is normal in the latest public bucket.",
      ELEVATED: "Sector dispersion is elevated in the latest public bucket.",
    },
  });
  addRisk(risks, {
    riskLabel: "Index trend",
    riskBucket: stringValue(row.trend_risk_bucket),
    interpretations: {
      DRAWDOWN: "Broad-market trend bucket is in drawdown.",
      WEAK: "Broad-market trend bucket is weak.",
      POSITIVE: "Broad-market trend bucket is positive.",
      STRONG_RALLY: "Broad-market trend bucket is a strong rally.",
    },
  });
  return risks;
}

function addRisk(
  risks: RegimeHistoricalPlaybookRiskView[],
  input: {
    riskLabel: string;
    riskBucket?: string;
    interpretations: Record<string, string>;
  },
): void {
  if (!input.riskBucket || input.riskBucket === "UNKNOWN") return;
  risks.push({
    riskLabel: input.riskLabel,
    riskBucket: input.riskBucket,
    interpretation:
      input.interpretations[input.riskBucket] ??
      `${input.riskLabel} bucket is ${input.riskBucket}.`,
  });
}

function buildSummaryBullets(
  regime: string,
  rows: RegimeHistoricalPlaybookRowView[],
  risks: RegimeHistoricalPlaybookRiskView[],
): string[] {
  const leaders = rows.filter((row) => row.role === "leader").slice(0, 3);
  const laggards = rows.filter((row) => row.role === "laggard").slice(0, 3);
  const bullets: string[] = [];
  if (leaders.length) {
    bullets.push(
      `In ${regime} regimes, historical sector leaders in this view include ${joinLabels(
        leaders.map((row) => row.sector),
      )}.`,
    );
  }
  if (laggards.length) {
    bullets.push(
      `Historical laggards in this view include ${joinLabels(
        laggards.map((row) => row.sector),
      )}.`,
    );
  }
  if (risks.length) {
    bullets.push(
      `Public risk buckets available: ${joinLabels(
        risks.map((risk) => risk.riskLabel),
      )}.`,
    );
  }
  if (!bullets.length) {
    bullets.push(
      `Historical regime playbook evidence for ${regime} is limited in the public view.`,
    );
  }
  return bullets.slice(0, 4);
}

function buildFreshness(
  row: RegimeHistoricalPlaybookRow,
  asOfDate: string | undefined,
  now?: Date,
): ReturnType<typeof assessCapabilityFreshness> {
  return assessCapabilityFreshness({
    capability: "market_regime_historical_playbook",
    dataThrough: asOfDate,
    now,
    maxTradingDayLag: 2,
    hardTradingDayLag: 10,
    sources: [
      {
        sourceId: "regime_history",
        tableOrView: "md_research_sector_regime_fwd_agg",
        required: true,
        dataThrough: asOfDate,
        lastSuccessAt: dateTimeStringValue(row.regime_completed_at),
        refreshState: stringValue(row.regime_freshness_state),
      },
      {
        sourceId: "macro_snapshot",
        tableOrView: "md_macro_daily_snapshot",
        required: false,
        lastSuccessAt: dateTimeStringValue(row.macro_completed_at),
        refreshState: stringValue(row.macro_freshness_state),
      },
    ],
  });
}

function unavailableView(
  warnings: string[],
  freshness: CapabilityFreshness = { state: "unknown" },
  regime?: string,
  asOfDate?: string,
): RegimeHistoricalPlaybookView {
  return {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state: "unavailable",
    source: "pg_regime_history",
    ...(regime ? { regime } : {}),
    ...(asOfDate ? { asOfDate } : {}),
    rows: [],
    risks: [],
    summaryBullets: [],
    freshness,
    warnings,
  };
}

function inferEmphasis(message: string): RegimePlaybookEmphasis {
  if (/\b(risk|risks|risky|downside|underperform|underperforms|laggard|laggards|weak)\b/i.test(message)) {
    if (/\b(risk|risks|risky|downside)\b/i.test(message)) return "risks";
    return "laggards";
  }
  if (/\b(lead|leaders|works|favor|favour|usually\s+works|strong|outperform)\b/i.test(message)) {
    return "leaders";
  }
  return "general";
}

function roleValue(value: unknown): RegimeHistoricalPlaybookRole | undefined {
  const role = stringValue(value);
  if (role === "leader" || role === "laggard" || role === "mixed") return role;
  return undefined;
}

function clampMaxRows(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 1), MAX_ROWS_CAP);
}

function isExternalPgConfigured(): boolean {
  return Boolean(process.env.EXTERNAL_PG_HOST && process.env.EXTERNAL_PG_DATABASE);
}

function roundNumber(value: unknown, decimals: number): number | undefined {
  const parsed = numericValue(value);
  if (parsed == null || !Number.isFinite(parsed)) return undefined;
  const scale = 10 ** decimals;
  return Math.round(parsed * scale) / scale;
}

function numericValue(value: unknown): number | undefined {
  const direct = numberValue(value);
  if (direct != null) return direct;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function integerValue(value: unknown): number | undefined {
  const parsed = numericValue(value);
  if (parsed == null) return undefined;
  return Math.trunc(parsed);
}

function boolValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return value === 1;
}

function dateStringValue(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return stringValue(value);
}

function dateTimeStringValue(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return stringValue(value);
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined && item !== null) out[key] = item;
  }
  return out as T;
}

function joinLabels(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
