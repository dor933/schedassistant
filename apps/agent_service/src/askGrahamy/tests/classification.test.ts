import test from "node:test";
import assert from "node:assert/strict";
import { classifyMessage, type ClassifierOutput } from "../classification";

const stub = (
  out: Omit<ClassifierOutput, "comparison"> &
    Partial<Pick<ClassifierOutput, "comparison">>,
) => async (): Promise<ClassifierOutput> => ({ comparison: null, ...out });

test("classifies a stock question", async () => {
  const result = await classifyMessage("What do you think about NVDA?", undefined, {
    classifier: stub({
      intent: "stock",
      symbols: ["NVDA"],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      confidence: "high",
    }),
  });
  assert.equal(result.intent, "stock");
  assert.deepEqual(result.symbols, ["NVDA"]);
  assert.deepEqual(result.requiresTools, [
    "get_stock_snapshot_context",
    "get_market_context",
  ]);
});

test("resolves company name to ticker via the LLM", async () => {
  const result = await classifyMessage("what about nvidia?", undefined, {
    classifier: stub({
      intent: "stock",
      symbols: ["NVDA"],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      confidence: "medium",
    }),
  });
  assert.equal(result.intent, "stock");
  assert.deepEqual(result.symbols, ["NVDA"]);
  assert.deepEqual(result.warnings, []);
});

test("classifies a sector question", async () => {
  const result = await classifyMessage(
    "What is happening in semiconductors?",
    undefined,
    {
      classifier: stub({
        intent: "sector",
        symbols: [],
        sectors: ["Semiconductors"],
        regimeRequested: false,
        isFollowUp: false,
        confidence: "high",
      }),
    },
  );
  assert.equal(result.intent, "sector");
  assert.deepEqual(result.sectors, ["Semiconductors"]);
});

test("classifies anchorless sector conviction leaderboard questions", async () => {
  const result = await classifyMessage(
    "Which sectors are leading on conviction this week?",
    undefined,
    {
      classifier: stub({
        intent: "sector_conviction_leaderboard",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: false,
        confidence: "high",
      }),
    },
  );
  assert.equal(result.intent, "sector_conviction_leaderboard");
  assert.deepEqual(result.symbols, []);
  assert.deepEqual(result.sectors, []);
  assert.deepEqual(result.requiresTools, ["get_market_context"]);
});

test("does not require a ticker or sector for sector conviction leaderboard", async () => {
  const result = await classifyMessage(
    "Show me the sector conviction leaderboard",
    undefined,
    {
      classifier: stub({
        intent: "sector_conviction_leaderboard",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: false,
        confidence: "high",
      }),
    },
  );
  assert.equal(result.intent, "sector_conviction_leaderboard");
  assert.equal(result.requiresTools.length, 1);
});

test("classifies historical forward profile sector leaderboard phrasing", async () => {
  const historical = await classifyMessage(
    "Which sectors have strongest historical forward profile?",
    undefined,
    {
      classifier: stub({
        intent: "sector_conviction_leaderboard",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: false,
        confidence: "high",
      }),
    },
  );
  assert.equal(historical.intent, "sector_conviction_leaderboard");
});

test("classifies sector conviction/momentum divergence phrasings", async () => {
  const divergence = await classifyMessage(
    "Which sectors have conviction but weak price action?",
    undefined,
    {
      classifier: stub({
        intent: "sector_momentum_vs_conviction_divergence",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: false,
        confidence: "high",
      }),
    },
  );
  assert.equal(divergence.intent, "sector_momentum_vs_conviction_divergence");
  assert.deepEqual(divergence.symbols, []);
  assert.deepEqual(divergence.sectors, []);
  assert.deepEqual(divergence.requiresTools, ["get_market_context"]);

  const notConfirming = await classifyMessage(
    "Any sectors where the market is not confirming the data yet?",
    undefined,
    {
      classifier: stub({
        intent: "sector_momentum_vs_conviction_divergence",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: false,
        confidence: "high",
      }),
    },
  );
  assert.equal(
    notConfirming.intent,
    "sector_momentum_vs_conviction_divergence",
  );
});

test("classifies week-over-week sector delta phrasings", async () => {
  const improved = await classifyMessage(
    "Which sectors improved most versus last week?",
    undefined,
    {
      classifier: stub({
        intent: "week_over_week_sector_delta",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: false,
        confidence: "high",
      }),
    },
  );
  assert.equal(improved.intent, "week_over_week_sector_delta");
  assert.deepEqual(improved.symbols, []);
  assert.deepEqual(improved.sectors, []);
  assert.deepEqual(improved.requiresTools, ["get_market_context"]);

  const deteriorated = await classifyMessage(
    "Which sectors deteriorated versus last week?",
    undefined,
    {
      classifier: stub({
        intent: "week_over_week_sector_delta",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: false,
        confidence: "high",
      }),
    },
  );
  assert.equal(deteriorated.intent, "week_over_week_sector_delta");

  const momentum = await classifyMessage(
    "Which sectors lost momentum this week?",
    undefined,
    {
      classifier: stub({
        intent: "week_over_week_sector_delta",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: false,
        confidence: "high",
      }),
    },
  );
  assert.equal(momentum.intent, "week_over_week_sector_delta");
});

test("routes broad no-context changed-since-last-week to sector delta", async () => {
  const result = await classifyMessage("What changed since last week?", undefined, {
    classifier: stub({
      intent: "week_over_week_sector_delta",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      confidence: "high",
    }),
  });
  assert.equal(result.intent, "week_over_week_sector_delta");
  assert.deepEqual(result.requiresTools, ["get_market_context"]);
});

test("preserves stock follow-up behavior for changed-since-last-week with stock context", async () => {
  const result = await classifyMessage(
    "What changed since last week?",
    {
      conversationId: "c1",
      userId: 1,
      lastSymbols: ["GSL"],
      lastSectors: [],
      lastIntent: "stock",
      lastSuggestedFollowups: [],
      updatedAt: new Date().toISOString(),
    },
    {
      classifier: stub({
        intent: "follow_up",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: true,
        confidence: "medium",
      }),
    },
  );
  assert.equal(result.intent, "follow_up");
  assert.deepEqual(result.requiresTools, []);
});

test("classifies anchorless stock idea discovery questions", async () => {
  const interesting = await classifyMessage("Give me an interesting stock", undefined, {
    classifier: stub({
      intent: "stock_idea_discovery",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      confidence: "high",
    }),
  });
  assert.equal(interesting.intent, "stock_idea_discovery");
  assert.deepEqual(interesting.symbols, []);
  assert.deepEqual(interesting.sectors, []);
  assert.deepEqual(interesting.requiresTools, ["get_market_context"]);
  assert.deepEqual(interesting.warnings, []);

  const today = await classifyMessage("What should I look at today?", undefined, {
    classifier: stub({
      intent: "stock_idea_discovery",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      confidence: "high",
    }),
  });
  assert.equal(today.intent, "stock_idea_discovery");
  assert.deepEqual(today.symbols, []);
  assert.deepEqual(today.sectors, []);
  assert.deepEqual(today.requiresTools, ["get_market_context"]);
});

test("classifies stock-vs-sector comparison with implicit sector anchor", async () => {
  const result = await classifyMessage("Compare GSL to its sector", undefined, {
    classifier: stub({
      intent: "comparison",
      symbols: ["GSL"],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      comparison: {
        comparisonType: "stock_vs_sector",
        left: { type: "stock", symbol: "GSL" },
        right: { type: "implicit_stock_sector", sector: null },
      },
      confidence: "high",
    }),
  });

  assert.equal(result.intent, "comparison");
  assert.deepEqual(result.symbols, []);
  assert.deepEqual(result.sectors, []);
  assert.deepEqual(result.requiresTools, ["get_market_context"]);
  assert.deepEqual(result.comparison, {
    comparisonType: "stock_vs_sector",
    left: { type: "stock", symbol: "GSL" },
      right: { type: "implicit_stock_sector" },
  });
});

test("classifies stock-vs-sector comparison with explicit sector anchor", async () => {
  const result = await classifyMessage(
    "How does GSL look versus Financial Services?",
    undefined,
    {
      classifier: stub({
        intent: "comparison",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: false,
        comparison: {
          comparisonType: "stock_vs_sector",
          left: { type: "stock", symbol: "gsl" },
          right: { type: "sector", sector: "Financial Services" },
        },
        confidence: "high",
      }),
    },
  );

  assert.equal(result.intent, "comparison");
  assert.deepEqual(result.comparison, {
    comparisonType: "stock_vs_sector",
    left: { type: "stock", symbol: "GSL" },
    right: { type: "sector", sector: "Financial Services" },
  });
});

test("classifier-emitted intent='comparison' without metadata stays unknown for unsupported symbol-vs-symbol", async () => {
  // The LLM said "comparison" but didn't fill the stock-vs-sector comparison
  // object. Symbol-vs-symbol is intentionally not implemented in this phase,
  // so we do not recover GSL-vs-DAC into a comparison capability.
  const result = await classifyMessage("Compare GSL vs DAC", undefined, {
    classifier: stub({
      intent: "comparison",
      symbols: ["GSL", "DAC"],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      confidence: "high",
    }),
  });

  assert.equal(result.intent, "unknown");
  assert.equal(result.comparison, undefined);
});

test("fallback routes invalid stock-vs-sector-shaped anchors to comparison", async () => {
  const invalidSymbol = await classifyMessage("Compare FAKE123 to its sector", undefined, {
    classifier: stub({
      intent: "unknown",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      confidence: "low",
    }),
  });
  assert.equal(invalidSymbol.intent, "comparison");
  assert.deepEqual(invalidSymbol.comparison, {
    comparisonType: "stock_vs_sector",
    left: { type: "stock", symbol: "FAKE123" },
    right: { type: "implicit_stock_sector" },
  });

  const invalidSector = await classifyMessage("Compare GSL to Banana Sector", undefined, {
    classifier: stub({
      intent: "unknown",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      confidence: "low",
    }),
  });
  assert.equal(invalidSector.intent, "comparison");
  assert.deepEqual(invalidSector.comparison, {
    comparisonType: "stock_vs_sector",
    left: { type: "stock", symbol: "GSL" },
    right: { type: "sector", sector: "Banana Sector" },
  });
});

test("symbol-vs-symbol requests remain unknown until that comparison type is implemented", async () => {
  const symbolVsSymbol = await classifyMessage("Compare GSL vs DAC", undefined, {
    classifier: stub({
      intent: "unknown",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      confidence: "low",
    }),
  });
  assert.equal(symbolVsSymbol.intent, "unknown");
  assert.equal(symbolVsSymbol.comparison, undefined);
});

test("sector-vs-sector requests are still classified as unknown", async () => {
  // "Compare Technology vs Industrials" — neither word looks like a ticker
  // anchor (>5 chars, mixed case), so both the stock-vs-sector and the
  // stock-vs-stock fallbacks bail out and the message stays unknown.
  const sectorVsSector = await classifyMessage(
    "Compare Technology vs Industrials",
    undefined,
    {
      classifier: stub({
        intent: "unknown",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: false,
        confidence: "low",
      }),
    },
  );
  assert.equal(sectorVsSector.intent, "unknown");
  assert.equal(sectorVsSector.comparison, undefined);
});

test("does not require a ticker for stock idea discovery", async () => {
  const result = await classifyMessage("Show me top conviction names today", undefined, {
    classifier: stub({
      intent: "stock_idea_discovery",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      confidence: "high",
    }),
  });
  assert.equal(result.intent, "stock_idea_discovery");
  assert.deepEqual(result.symbols, []);
  assert.equal(result.requiresTools.length, 1);
});

test("keeps anchorless follow-up for deep-agent conversation memory", async () => {
  const result = await classifyMessage(
    "Why?",
    {
      conversationId: "c1",
      userId: 1,
      lastSymbols: ["NVDA"],
      lastSectors: [],
      lastIntent: "stock",
      lastSuggestedFollowups: [],
      updatedAt: new Date().toISOString(),
    },
    {
      classifier: stub({
        intent: "follow_up",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: true,
        confidence: "medium",
      }),
    },
  );
  assert.equal(result.intent, "follow_up");
  assert.equal(result.isFollowUp, true);
  assert.deepEqual(result.symbols, []);
  assert.deepEqual(result.requiresTools, []);
});

test("self-anchored follow-up phrasing bypasses missing-context warning", async () => {
  // "what about X and the Y sector?" reads as a follow-up but the message
  // itself names everything we need. Even with no prior context, we should
  // answer it cleanly rather than falling into the clarification path.
  const result = await classifyMessage(
    "what about jp morgan and the energy sector?",
    undefined,
    {
      classifier: stub({
        intent: "stock_sector",
        symbols: ["JPM"],
        sectors: ["Energy"],
        regimeRequested: false,
        isFollowUp: true,
        confidence: "high",
      }),
    },
  );
  assert.equal(result.intent, "stock_sector");
  assert.deepEqual(result.symbols, ["JPM"]);
  assert.deepEqual(result.sectors, ["Energy"]);
  assert.equal(result.isFollowUp, true);
  assert.deepEqual(result.warnings, []);
});

test("keeps unresolved follow-up as follow-up path for agent memory", async () => {
  const result = await classifyMessage("Why?", undefined, {
    classifier: stub({
      intent: "follow_up",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: true,
      confidence: "low",
    }),
  });
  assert.equal(result.intent, "follow_up");
  assert.equal(result.confidence, "low");
  assert.equal(result.requiresTools.length, 0);
  assert.deepEqual(result.warnings, []);
});

test("classifies an anchorless sector conviction leaderboard question", async () => {
  const result = await classifyMessage(
    "Which sectors are leading on conviction this week?",
    undefined,
    {
      classifier: stub({
        intent: "sector_conviction_leaderboard",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: false,
        confidence: "high",
      }),
    },
  );
  assert.equal(result.intent, "sector_conviction_leaderboard");
  assert.deepEqual(result.symbols, []);
  assert.deepEqual(result.sectors, []);
  assert.deepEqual(result.requiresTools, ["get_market_context"]);
});

test("preserves sector conviction leaderboard without ticker or sector anchor", async () => {
  const result = await classifyMessage(
    "Show me the sector conviction leaderboard",
    undefined,
    {
      classifier: stub({
        intent: "sector_conviction_leaderboard",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: false,
        confidence: "high",
      }),
    },
  );
  assert.equal(result.intent, "sector_conviction_leaderboard");
  assert.equal(result.warnings.length, 0);
});

test("returns unknown with warning when classifier throws", async () => {
  const result = await classifyMessage("aaa", undefined, {
    classifier: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(result.intent, "unknown");
  assert.equal(result.requiresTools.length, 0);
  assert.match(result.warnings[0], /classifier unavailable/i);
});
