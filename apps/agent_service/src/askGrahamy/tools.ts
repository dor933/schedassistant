import { observeToolCall } from "../langfuse";
import { isRecord, numberValue, stringValue } from "./snapshotClient";
import type {
  Classification,
  HomepageFocusContext,
  IndustryLandscape,
  MarketContext,
  SectorLandscape,
  SnapshotBundle,
  StockResearchContext,
  ToolName,
  ToolOutputs,
} from "./types";

export async function executeSnapshotTools(
  tools: ToolName[],
  snapshots: SnapshotBundle,
  classification: Classification,
): Promise<ToolOutputs> {
  const outputs: ToolOutputs = {};
  for (const tool of tools) {
    if (tool === "get_market_context") {
      outputs.get_market_context = await observeToolCall(
        "get_market_context",
        {},
        async () => getMarketContext(snapshots),
      );
    }
    if (tool === "get_stock_snapshot_context") {
      outputs.get_stock_snapshot_context = await observeToolCall(
        "get_stock_snapshot_context",
        { symbols: classification.symbols },
        async () => getStockSnapshotContext(snapshots, classification.symbols),
      );
    }
    if (tool === "get_sector_snapshot_context") {
      outputs.get_sector_snapshot_context = await observeToolCall(
        "get_sector_snapshot_context",
        { sectors: classification.sectors },
        async () => getSectorSnapshotContext(snapshots, classification.sectors),
      );
    }
    if (tool === "get_industry_snapshot_context") {
      outputs.get_industry_snapshot_context = await observeToolCall(
        "get_industry_snapshot_context",
        { industries: classification.industries },
        async () =>
          getIndustrySnapshotContext(snapshots, classification.industries),
      );
    }
    if (tool === "get_homepage_focus_context") {
      outputs.get_homepage_focus_context = await observeToolCall(
        "get_homepage_focus_context",
        {},
        async () => getHomepageFocusContext(snapshots),
      );
    }
  }
  return outputs;
}

export function getMarketContext(snapshots: SnapshotBundle): MarketContext {
  const daily = isRecord(snapshots.daily_brief) ? snapshots.daily_brief : {};
  const transparency = isRecord(snapshots.transparency) ? snapshots.transparency : {};
  return {
    regime: stringValue(daily.regime),
    vix: numberValue(daily.vix),
    vixDate: stringValue(daily.vix_date),
    activeEdges: numberValue(daily.total_active_edges),
    stocksWithConvergence: numberValue(daily.stocks_with_convergence),
    forwardWinRateBucket: bucketRate(numberValue(daily.forward_wr_overall)),
    pipelineStatus: snapshots.freshness?.pipelineStatus,
    methodologySummary: stringValue(transparency.methodology_summary),
  };
}

export function getStockSnapshotContext(
  snapshots: SnapshotBundle,
  symbols: string[],
): StockResearchContext {
  const dailyStocks = getArray(snapshots.daily_brief, "stocks");
  const signals = getArray(snapshots.track_record, "signals");
  const result: StockResearchContext = {
    symbols: [],
    missingSymbols: [],
  };

  for (const symbol of symbols.map((item) => item.toUpperCase())) {
    const daily = dailyStocks.find((item) => isRecord(item) && stringValue(item.ticker)?.toUpperCase() === symbol);
    const completedSignals = signals.filter((item) => isRecord(item) && stringValue(item.ticker)?.toUpperCase() === symbol);
    if (!isRecord(daily) && completedSignals.length === 0) {
      result.missingSymbols.push(symbol);
      continue;
    }

    const wins = completedSignals.filter((item) => isRecord(item) && stringValue(item.result)?.toUpperCase() === "WIN").length;
    const completedWinRate = completedSignals.length ? wins / completedSignals.length : undefined;
    const newsSignals = isRecord(daily) && Array.isArray(daily.news_signals) ? daily.news_signals : [];

    result.symbols.push({
      symbol,
      company: isRecord(daily) ? stringValue(daily.company) : undefined,
      sector: isRecord(daily) ? stringValue(daily.sector) : firstString(completedSignals, "sector"),
      convergenceScore: isRecord(daily) ? numberValue(daily.convergence_score) : undefined,
      confluenceLevel: isRecord(daily) ? stringValue(daily.confluence_level) : undefined,
      evidenceCount: newsSignals.length || completedSignals.length || undefined,
      notableEvents: newsSignals.slice(0, 3).filter(isRecord).map((event) => ({
        date: stringValue(event.date),
        eventType: stringValue(event.event_type),
        description: stringValue(event.description),
        impactBucket: bucketImpact(numberValue(event.price_impact_best)),
        confidence: numberValue(event.confidence),
      })),
      completedSignalCount: completedSignals.length || undefined,
      completedWinRateBucket: bucketRate(completedWinRate),
    });
  }

  return result;
}

export function getSectorSnapshotContext(
  snapshots: SnapshotBundle,
  sectors: string[],
): SectorLandscape {
  const dailyStocks = getArray(snapshots.daily_brief, "stocks");
  const signals = getArray(snapshots.track_record, "signals");
  const normalizedTargets = sectors.map(normalizeSector);
  const landscape: SectorLandscape = { sectors: [], missingSectors: [] };

  for (const sector of sectors) {
    const target = normalizeSector(sector);
    const matchingStocks = dailyStocks.filter((item) => isRecord(item) && normalizeSector(stringValue(item.sector)) === target);
    const matchingSignals = signals.filter((item) => isRecord(item) && normalizeSector(stringValue(item.sector)) === target);
    if (matchingStocks.length === 0 && matchingSignals.length === 0) {
      landscape.missingSectors.push(sector);
      continue;
    }

    const exampleSymbols = matchingStocks
      .filter(isRecord)
      .map((item) => stringValue(item.ticker))
      .filter((item): item is string => !!item)
      .slice(0, 5);
    const wins = matchingSignals.filter((item) => isRecord(item) && stringValue(item.result)?.toUpperCase() === "WIN").length;
    const winRate = matchingSignals.length ? wins / matchingSignals.length : undefined;

    landscape.sectors.push({
      sector,
      stocksInFocus: matchingStocks.length,
      exampleSymbols,
      convergenceScoreTotal: matchingStocks
        .filter(isRecord)
        .reduce((sum, item) => sum + (numberValue(item.convergence_score) ?? 0), 0) || undefined,
      completedSignalCount: matchingSignals.length || undefined,
      completedWinRateBucket: bucketRate(winRate),
    });
  }

  if (landscape.sectors.length === 0 && normalizedTargets.length === 0) {
    const bySector = new Map<string, { stocks: Set<string>; score: number }>();
    for (const item of dailyStocks.filter(isRecord)) {
      const sector = stringValue(item.sector);
      const ticker = stringValue(item.ticker);
      if (!sector || !ticker) continue;
      const current = bySector.get(sector) ?? { stocks: new Set<string>(), score: 0 };
      current.stocks.add(ticker);
      current.score += numberValue(item.convergence_score) ?? 0;
      bySector.set(sector, current);
    }
    landscape.sectors = Array.from(bySector.entries())
      .sort((a, b) => b[1].stocks.size - a[1].stocks.size)
      .slice(0, 5)
      .map(([sector, data]) => ({
        sector,
        stocksInFocus: data.stocks.size,
        exampleSymbols: Array.from(data.stocks).slice(0, 5),
        convergenceScoreTotal: data.score || undefined,
      }));
  }

  return landscape;
}

/**
 * Industry snapshot tool. Unlike the sector snapshot — which can lean on
 * `daily_brief.stocks[].sector` for example symbols + win-rate buckets —
 * the daily brief does not attribute stocks to industries, so this tool
 * returns a thin pre-RO summary. The substantive industry payload (member
 * counts, today's industry PE, top members, historical base rate, path
 * risk) lives on the industry research object built from
 * `query_v6a_industry_live.sql`. We flag `researchObjectAttached: true`
 * for every requested industry so the agent prompt knows the deep payload
 * is available alongside this thin context.
 */
export function getIndustrySnapshotContext(
  _snapshots: SnapshotBundle,
  industries: string[],
): IndustryLandscape {
  return {
    industries: industries.map((industry) => ({
      industry,
      researchObjectAttached: true,
    })),
    missingIndustries: [],
  };
}

export function getHomepageFocusContext(snapshots: SnapshotBundle): HomepageFocusContext {
  const dailyStocks = getArray(snapshots.daily_brief, "stocks").filter(isRecord);
  const focusSymbols = dailyStocks
    .map((item) => stringValue(item.ticker))
    .filter((item): item is string => !!item)
    .slice(0, 8);
  const focusSectors = Array.from(
    new Set(
      dailyStocks
        .map((item) => stringValue(item.sector))
        .filter((item): item is string => !!item),
    ),
  ).slice(0, 6);
  return { focusSymbols, focusSectors };
}

function getArray(source: unknown, key: string): unknown[] {
  if (!isRecord(source)) return [];
  const value = source[key];
  return Array.isArray(value) ? value : [];
}

function firstString(items: unknown[], key: string): string | undefined {
  for (const item of items) {
    if (!isRecord(item)) continue;
    const value = stringValue(item[key]);
    if (value) return value;
  }
  return undefined;
}

function normalizeSector(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function bucketRate(rate: number | undefined): string | undefined {
  if (rate == null) return undefined;
  if (rate >= 0.6) return "strong";
  if (rate >= 0.52) return "constructive";
  if (rate >= 0.45) return "mixed";
  return "weak";
}

function bucketImpact(value: number | undefined): string | undefined {
  if (value == null) return undefined;
  const magnitude = Math.abs(value);
  if (magnitude >= 20) return value > 0 ? "large positive" : "large negative";
  if (magnitude >= 8) return value > 0 ? "moderate positive" : "moderate negative";
  return value > 0 ? "small positive" : "small negative";
}

