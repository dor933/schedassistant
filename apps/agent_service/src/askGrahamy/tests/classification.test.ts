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

test("classifies anchored risk-only stock questions with risk focus", async () => {
  const examples = [
    "How risky is GSL?",
    "How bad can GSL fall along the way?",
    "What is the drawdown risk for GSL?",
    "What is the probability of losing more than 10% for GSL?",
    "What does path risk look like for GSL?",
    "Is the downside risk elevated for GSL?",
  ];

  for (const message of examples) {
    const result = await classifyMessage(message, undefined, {
      classifier: stub({
        intent: "stock",
        symbols: ["GSL"],
        sectors: [],
        regimeRequested: false,
        isFollowUp: false,
        confidence: "high",
      }),
    });
    assert.equal(result.intent, "stock", message);
    assert.deepEqual(result.symbols, ["GSL"], message);
    assert.equal(result.focus, "risk", message);
    assert.deepEqual(result.requiresTools, [
      "get_stock_snapshot_context",
      "get_market_context",
    ]);
  }
});

test("risk-only follow-up inherits prior anchor when context is available", async () => {
  const result = await classifyMessage(
    "What is the probability of losing more than 10%?",
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
        intent: "unknown",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: true,
        focus: "risk",
        confidence: "medium",
      }),
    },
  );

  assert.equal(result.intent, "stock");
  assert.deepEqual(result.symbols, ["GSL"]);
  assert.equal(result.focus, "risk");
  assert.equal(result.isFollowUp, true);
});

test("risk-only follow-up without prior anchor returns unknown", async () => {
  const result = await classifyMessage(
    "What is the probability of losing more than 10%?",
    undefined,
    {
      classifier: stub({
        intent: "unknown",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: true,
        focus: "risk",
        confidence: "low",
      }),
    },
  );

  assert.equal(result.intent, "unknown");
  assert.deepEqual(result.symbols, []);
  assert.equal(result.focus, undefined);
  assert.match(result.warnings[0], /could not classify/i);
});

test("ordinary stock analysis does not set risk focus", async () => {
  const result = await classifyMessage("Tell me about GSL", undefined, {
    classifier: stub({
      intent: "stock",
      symbols: ["GSL"],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      confidence: "high",
    }),
  });

  assert.equal(result.intent, "stock");
  assert.deepEqual(result.symbols, ["GSL"]);
  assert.equal(result.focus, undefined);
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

test("classifier-emitted intent='comparison' without metadata falls back to symbol-vs-symbol when two tickers are named", async () => {
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

  assert.equal(result.intent, "comparison");
  assert.deepEqual(result.comparison, {
    comparisonType: "symbol_vs_symbol",
    left: { type: "stock", symbol: "GSL" },
    right: { type: "stock", symbol: "DAC" },
  });
});

test("classifies sector-vs-sector comparison with canonical sector anchors", async () => {
  const result = await classifyMessage("Compare Technology vs Industrials", undefined, {
    classifier: stub({
      intent: "comparison",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      comparison: {
        comparisonType: "sector_vs_sector",
        left: { type: "sector", sector: "Technology" },
        right: { type: "sector", sector: "Industrials" },
      },
      confidence: "high",
    }),
  });

  assert.equal(result.intent, "comparison");
  assert.deepEqual(result.symbols, []);
  assert.deepEqual(result.sectors, []);
  assert.deepEqual(result.requiresTools, ["get_market_context"]);
  assert.deepEqual(result.comparison, {
    comparisonType: "sector_vs_sector",
    left: { type: "sector", sector: "Technology" },
    right: { type: "sector", sector: "Industrials" },
  });
});

test("fallback routes sector-vs-sector examples to comparison", async () => {
  const examples = [
    {
      message: "Compare Technology vs Industrials",
      left: "Technology",
      right: "Industrials",
    },
    {
      message: "Which sector looks better, Energy or Industrials?",
      left: "Energy",
      right: "Industrials",
    },
    {
      message: "Is Healthcare stronger than Financial Services?",
      left: "Healthcare",
      right: "Financial Services",
    },
    {
      message: "Compare Consumer Defensive with Consumer Cyclical",
      left: "Consumer Defensive",
      right: "Consumer Cyclical",
    },
  ];

  for (const item of examples) {
    const result = await classifyMessage(item.message, undefined, {
      classifier: stub({
        intent: "unknown",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: false,
        confidence: "low",
      }),
    });
    assert.equal(result.intent, "comparison", item.message);
    assert.deepEqual(result.comparison, {
      comparisonType: "sector_vs_sector",
      left: { type: "sector", sector: item.left },
      right: { type: "sector", sector: item.right },
    });
  }
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

test("fallback routes symbol-vs-symbol examples to comparison", async () => {
  const examples = [
    ["Compare GSL vs DAC", "GSL", "DAC"],
    ["Which is stronger, AMZN or NVDA?", "AMZN", "NVDA"],
    ["Compare AAPL and MSFT", "AAPL", "MSFT"],
    ["Compare GSL vs GSL", "GSL", "GSL"],
  ] as const;

  for (const [message, left, right] of examples) {
    const result = await classifyMessage(message, undefined, {
      classifier: stub({
        intent: "unknown",
        symbols: [],
        sectors: [],
        regimeRequested: false,
        isFollowUp: false,
        confidence: "low",
      }),
    });
    assert.equal(result.intent, "comparison", message);
    assert.deepEqual(result.comparison, {
      comparisonType: "symbol_vs_symbol",
      left: { type: "stock", symbol: left },
      right: { type: "stock", symbol: right },
    });
  }
});

test("classifies LLM-emitted symbol-vs-symbol comparison", async () => {
  const result = await classifyMessage("Is AMZN better than NVDA?", undefined, {
    classifier: stub({
      intent: "comparison",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      comparison: {
        comparisonType: "symbol_vs_symbol",
        left: { type: "stock", symbol: "amzn" },
        right: { type: "stock", symbol: "nvda" },
      },
      confidence: "high",
    }),
  });
  assert.equal(result.intent, "comparison");
  assert.deepEqual(result.comparison, {
    comparisonType: "symbol_vs_symbol",
    left: { type: "stock", symbol: "AMZN" },
    right: { type: "stock", symbol: "NVDA" },
  });
});

test("invalid sector-vs-sector-shaped request routes to comparison for public unavailable response", async () => {
  const sectorVsSector = await classifyMessage(
    "Compare Banana Sector vs Industrials",
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
  assert.equal(sectorVsSector.intent, "comparison");
  assert.deepEqual(sectorVsSector.comparison, {
    comparisonType: "sector_vs_sector",
    left: { type: "sector", sector: "Banana Sector" },
    right: { type: "sector", sector: "Industrials" },
  });
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
