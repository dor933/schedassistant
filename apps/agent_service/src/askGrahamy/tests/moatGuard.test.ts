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
