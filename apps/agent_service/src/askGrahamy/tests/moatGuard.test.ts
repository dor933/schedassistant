import test from "node:test";
import assert from "node:assert/strict";
import { runMoatGuard } from "../moatGuard";

test("removes forbidden fields recursively and redacts forbidden text", () => {
  const result = runMoatGuard({
    answer: {
      summary: "Do not expose signal_sql or raw_alpha.",
    },
    research: {
      edge_id: "edge-1",
      nested: {
        raw_wr: 0.73,
        allowed: "ok",
      },
    },
  });

  assert.equal(result.result, "cleaned");
  assert.equal((result.value as any).research.edge_id, undefined);
  assert.equal((result.value as any).research.nested.raw_wr, undefined);
  assert.equal((result.value as any).research.nested.allowed, "ok");
  assert.match((result.value as any).answer.summary, /restricted internal detail/);
});

test("removes raw analog and gate fields without stripping public drawdown probabilities", () => {
  const result = runMoatGuard({
    pathRisk: {
      probDrawdownGt10Pct: 18,
      gate_name: "internal gate",
      internal_threshold: 0.42,
      raw_analog_rows: [{ id: 1 }],
      path_rows: [{ path_day: 1 }],
    },
  });

  assert.equal(result.result, "cleaned");
  assert.equal((result.value as any).pathRisk.probDrawdownGt10Pct, 18);
  assert.equal((result.value as any).pathRisk.gate_name, undefined);
  assert.equal((result.value as any).pathRisk.internal_threshold, undefined);
  assert.equal((result.value as any).pathRisk.raw_analog_rows, undefined);
  assert.equal((result.value as any).pathRisk.path_rows, undefined);
});

test("removes divergence scoring internals without stripping public sector divergence fields", () => {
  const result = runMoatGuard({
    sectorDivergenceView: {
      rows: [
        {
          sector: "Utilities",
          rank: 1,
          momentumScorePct: 30,
          divergenceType: "conviction_but_weak_price_action",
          divergenceScorePct: 91,
          score_formula: "internal formula",
          divergence_formula: "internal formula",
        },
      ],
    },
  });

  const row = (result.value as any).sectorDivergenceView.rows[0];
  assert.equal(result.result, "cleaned");
  assert.equal(row.sector, "Utilities");
  assert.equal(row.momentumScorePct, 30);
  assert.equal(row.divergenceType, "conviction_but_weak_price_action");
  assert.equal(row.divergenceScorePct, undefined);
  assert.equal(row.score_formula, undefined);
  assert.equal(row.divergence_formula, undefined);
});

test("removes sector delta formulas without stripping public delta fields", () => {
  const result = runMoatGuard({
    sectorDeltaView: {
      rows: [
        {
          sector: "Technology",
          rank: 1,
          convictionDeltaPct: 8,
          momentumDeltaPct: 5,
          direction: "improved",
          sector_delta_formula: "internal formula",
          conviction_formula: "internal formula",
          momentum_formula: "internal formula",
          raw_rows: [{ sector: "Technology" }],
        },
      ],
    },
  });

  const row = (result.value as any).sectorDeltaView.rows[0];
  assert.equal(result.result, "cleaned");
  assert.equal(row.sector, "Technology");
  assert.equal(row.convictionDeltaPct, 8);
  assert.equal(row.momentumDeltaPct, 5);
  assert.equal(row.direction, "improved");
  assert.equal(row.sector_delta_formula, undefined);
  assert.equal(row.conviction_formula, undefined);
  assert.equal(row.momentum_formula, undefined);
  assert.equal(row.raw_rows, undefined);
});

test("removes comparison formulas without stripping public comparison fields", () => {
  const result = runMoatGuard({
    comparisonView: {
      comparisonType: "stock_vs_sector",
      left: { symbol: "GSL", metrics: { convictionScorePct: 82 } },
      right: { sector: "Industrials", metrics: { convictionScorePct: 55 } },
      deltas: [
        {
          metric: "conviction",
          delta: 27,
          interpretationBucket: "left_stronger",
          comparison_formula: "internal formula",
          raw_rows: [{ symbol: "GSL" }],
        },
      ],
    },
  });

  const delta = (result.value as any).comparisonView.deltas[0];
  assert.equal(result.result, "cleaned");
  assert.equal((result.value as any).comparisonView.left.symbol, "GSL");
  assert.equal(delta.metric, "conviction");
  assert.equal(delta.delta, 27);
  assert.equal(delta.comparison_formula, undefined);
  assert.equal(delta.raw_rows, undefined);
});
