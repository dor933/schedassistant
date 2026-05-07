import type { PublicFreshnessView } from "../types";

export type FreshnessGuardDecision =
  | "allow"
  | "allow_with_caveat"
  | "unavailable";

export type FreshnessGuardReasonCode =
  | "fresh"
  | "soft_stale"
  | "hard_stale"
  | "missing_required_source"
  | "missing_data_through"
  | "unknown";

export type FreshnessGuardSource = {
  sourceId: string;
  tableOrView?: string;
  required: boolean;
  dataThrough?: string;
  lastSuccessAt?: string;
  refreshState?: string;
  maxAge?: string;
  age?: string;
};

export type FreshnessGuardInput = {
  capability: string;
  dataThrough?: string;
  sources: FreshnessGuardSource[];
  maxTradingDayLag?: number;
  hardTradingDayLag?: number;
  now?: Date;
};

export type FreshnessGuardAssessment = {
  publicFreshness: PublicFreshnessView;
  decision: FreshnessGuardDecision;
  reasonCode: FreshnessGuardReasonCode;
  internalDiagnostics: {
    capability: string;
    sources: FreshnessGuardSource[];
    latestExpectedMarketDate?: string;
    tradingDayLag?: number;
  };
};

const DEFAULT_MAX_TRADING_DAY_LAG = 1;
const DEFAULT_HARD_TRADING_DAY_LAG = 5;

export function assessCapabilityFreshness(
  input: FreshnessGuardInput,
): FreshnessGuardAssessment {
  const dataThrough = normalizeDate(input.dataThrough);
  const now = input.now ?? new Date();
  const latestExpectedMarketDate = latestMarketDate(now);
  const maxLag = input.maxTradingDayLag ?? DEFAULT_MAX_TRADING_DAY_LAG;
  const hardLag = input.hardTradingDayLag ?? DEFAULT_HARD_TRADING_DAY_LAG;
  const requiredSources = input.sources.filter((source) => source.required);
  const missingRequired = requiredSources.some(
    (source) => !source.refreshState && !source.lastSuccessAt,
  );
  const staleRequired = requiredSources.some((source) =>
    isStaleRefreshState(source.refreshState),
  );
  const tradingDayLag =
    dataThrough && latestExpectedMarketDate
      ? tradingDaysBetween(dataThrough, latestExpectedMarketDate)
      : undefined;

  const internalDiagnostics = {
    capability: input.capability,
    sources: input.sources,
    latestExpectedMarketDate,
    tradingDayLag,
  };

  if (!dataThrough) {
    return {
      publicFreshness: {
        state: "unknown",
        warning: "Freshness could not be verified for this view.",
      },
      decision: "allow_with_caveat",
      reasonCode: "missing_data_through",
      internalDiagnostics,
    };
  }

  if (tradingDayLag != null && tradingDayLag > hardLag) {
    return {
      publicFreshness: {
        dataThrough,
        state: "stale",
        warning: `This view uses stale data through ${dataThrough}; current ranking is unavailable.`,
      },
      decision: "unavailable",
      reasonCode: "hard_stale",
      internalDiagnostics,
    };
  }

  if (missingRequired) {
    return {
      publicFreshness: {
        dataThrough,
        state: "unknown",
        warning: `Freshness could not be verified for data through ${dataThrough}.`,
      },
      decision: "allow_with_caveat",
      reasonCode: "missing_required_source",
      internalDiagnostics,
    };
  }

  if (
    staleRequired ||
    (tradingDayLag != null && tradingDayLag > maxLag)
  ) {
    return {
      publicFreshness: {
        dataThrough,
        state: "stale",
        warning: `This view uses data through ${dataThrough}; treat it as a stale snapshot rather than a live current view.`,
      },
      decision: "allow_with_caveat",
      reasonCode: "soft_stale",
      internalDiagnostics,
    };
  }

  return {
    publicFreshness: {
      dataThrough,
      state: "fresh",
    },
    decision: "allow",
    reasonCode: "fresh",
    internalDiagnostics,
  };
}

function isStaleRefreshState(value: string | undefined): boolean {
  if (!value) return false;
  return !["FRESH", "OK", "COMPLETE", "COMPLETED"].includes(value.toUpperCase());
}

function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0];
}

function latestMarketDate(now: Date): string {
  const date = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ));
  const day = date.getUTCDay();
  if (day === 0) date.setUTCDate(date.getUTCDate() - 2);
  if (day === 6) date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function tradingDaysBetween(start: string, end: string): number {
  const startDate = parseDate(start);
  const endDate = parseDate(end);
  if (!startDate || !endDate || startDate >= endDate) return 0;

  let days = 0;
  const cursor = new Date(startDate);
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor <= endDate) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) days += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function parseDate(value: string): Date | undefined {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
