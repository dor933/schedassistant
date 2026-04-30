import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { AskGrahamyConversationStore } from "../conversationStore";
import { runAskGrahamyGraph } from "../graph";
import { GrahamySnapshotClient } from "../snapshotClient";

test("runs the graph end to end over mocked snapshots", async () => {
  const fetchImpl = async (url: string) => {
    const name = String(url).split("/").pop();
    const payloads: Record<string, unknown> = {
      metadata: {
        generated_at: "2026-04-29T12:00:00Z",
        data_through: "2026-04-29",
        pipeline_status: "OPERATIONAL",
      },
      daily_brief: {
        regime: "NEUTRAL",
        stocks: [{ ticker: "NVDA", company: "NVIDIA Corp.", sector: "Technology" }],
      },
      clusters: { total_clusters: 1 },
      track_record: { signals: [{ ticker: "NVDA", sector: "Technology", result: "WIN" }] },
      transparency: { methodology_summary: "Public methodology." },
    };
    return {
      ok: true,
      status: 200,
      json: async () => payloads[name ?? ""] ?? {},
    } as Response;
  };

  const storePath = path.join(os.tmpdir(), `ask-grahamy-test-${Date.now()}.json`);
  const response = await runAskGrahamyGraph(
    { userId: "u1", conversationId: null, message: "What do you think about NVDA?" },
    1,
    {
      snapshotClient: new GrahamySnapshotClient({ baseUrl: "http://grahamy.test", fetchImpl: fetchImpl as typeof fetch }),
      conversationStore: new AskGrahamyConversationStore(storePath),
      classifier: async () => ({
        intent: "stock",
        symbols: ["NVDA"],
        sectors: [],
        regimeRequested: false,
        isFollowUp: false,
        confidence: "high",
      }),
    },
  );

  assert.equal(response.answerType, "stock");
  assert.equal(response.classification.symbols[0], "NVDA");
  assert.equal(response.meta.moatGuardResult, "clean");
  assert.equal(response.answer.disclaimer, "This is not financial advice.");
});

