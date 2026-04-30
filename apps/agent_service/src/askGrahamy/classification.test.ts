import test from "node:test";
import assert from "node:assert/strict";
import { classifyMessage, type ClassifierOutput } from "./classification";

const stub = (out: ClassifierOutput) => async () => out;

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

test("resolves follow-up against previous context", async () => {
  const result = await classifyMessage(
    "Why?",
    {
      conversationId: "c1",
      userId: "u1",
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
  assert.equal(result.intent, "stock");
  assert.equal(result.isFollowUp, true);
  assert.deepEqual(result.symbols, ["NVDA"]);
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
  assert.equal(result.isFollowUp, false);
  assert.deepEqual(result.warnings, []);
});

test("keeps unresolved follow-up as clarification path", async () => {
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
  assert.match(result.warnings[0], /missing prior context/i);
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
