import test from "node:test";
import assert from "node:assert/strict";
import { getMarketContext, getSectorSnapshotContext, getStockSnapshotContext } from "./tools";

const snapshots = {
  freshness: { pipelineStatus: "OPERATIONAL" },
  daily_brief: {
    regime: "NEUTRAL",
    vix: 18.1,
    total_active_edges: 10,
    stocks_with_convergence: 2,
    forward_wr_overall: 0.56,
    stocks: [
      {
        ticker: "NVDA",
        company: "NVIDIA Corp.",
        sector: "Technology",
        convergence_score: 2,
        confluence_level: "MULTI",
        news_signals: [
          {
            date: "2026-04-29",
            event_type: "EARNINGS_BEAT",
            description: "earnings beat",
            price_impact_best: 12,
            confidence: 0.9,
          },
        ],
      },
    ],
  },
  track_record: {
    signals: [
      { ticker: "NVDA", sector: "Technology", result: "WIN" },
      { ticker: "NVDA", sector: "Technology", result: "LOSS" },
    ],
  },
};

test("extracts market context from published snapshots", () => {
  const market = getMarketContext(snapshots);
  assert.equal(market.regime, "NEUTRAL");
  assert.equal(market.forwardWinRateBucket, "constructive");
  assert.equal(market.pipelineStatus, "OPERATIONAL");
});

test("extracts stock context without raw internals", () => {
  const stock = getStockSnapshotContext(snapshots, ["NVDA"]);
  assert.equal(stock.symbols[0].symbol, "NVDA");
  assert.equal(stock.symbols[0].notableEvents?.[0].impactBucket, "moderate positive");
  assert.equal(stock.symbols[0].completedWinRateBucket, "mixed");
  assert.deepEqual(stock.missingSymbols, []);
});

test("extracts sector context", () => {
  const sector = getSectorSnapshotContext(snapshots, ["Technology"]);
  assert.equal(sector.sectors[0].sector, "Technology");
  assert.deepEqual(sector.sectors[0].exampleSymbols, ["NVDA"]);
});

