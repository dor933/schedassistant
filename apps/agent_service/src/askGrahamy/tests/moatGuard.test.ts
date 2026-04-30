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

