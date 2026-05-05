import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PipelineOverlayClient } from "./pipelineOverlays/client";
import { PIPELINE_OVERLAY_FORBIDDEN_TERMS } from "./pipelineOverlays/forbiddenFields";
import { mapManifestToPublicFreshness } from "./pipelineOverlays/manifestFreshness";
import {
  createPublicOverlayResult,
  stripForbiddenPipelineOverlayFields,
} from "./pipelineOverlays/publicMapper";
import {
  PIPELINE_OVERLAY_REGISTRY,
  pipelineOverlayRegistryEntry,
} from "./pipelineOverlays/registry";
import {
  executeValidatedEdgeEvidenceOverlay,
  mapValidatedEdgeEvidenceView,
} from "./pipelineOverlays/validatedEdgeEvidence";

type CapturedRequest = {
  url: string;
  init?: RequestInit;
};

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(headers ?? {}),
    },
  });
}

function fakeFetch(
  responses: Array<Response | Error>,
  captures: CapturedRequest[] = [],
): typeof fetch {
  let idx = 0;
  return (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    captures.push({ url: String(url), init });
    const response = responses[Math.min(idx, responses.length - 1)];
    idx += 1;
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
}

function hangingFetch(): typeof fetch {
  return ((_url: string | URL, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    })) as typeof fetch;
}

test("PipelineOverlayClient calls only the allowed Client API endpoints", async () => {
  const captures: CapturedRequest[] = [];
  const client = new PipelineOverlayClient({
    baseUrl: "http://client-api.local/",
    fetchImpl: fakeFetch([
      jsonResponse({ data: { as_of_date: "2026-05-01", pipeline_complete: true } }),
      jsonResponse({ data: { symbol: "GSL" } }),
      jsonResponse({ data: { sector: "Energy" } }),
      jsonResponse({ data: { regime: "NEUTRAL" } }),
      jsonResponse({ data: { comparison: "symbols" } }),
      jsonResponse({ data: { comparison: "sectors" } }),
    ], captures),
  });

  await client.fetchManifest();
  await client.fetchTickerResearch("gsl");
  await client.fetchSectorResearch("Financial Services");
  await client.fetchRegimeResearch("current");
  await client.fetchSymbolComparison("GSL", "DAC");
  await client.fetchSectorComparison("Technology", "Industrials");

  assert.deepEqual(captures.map((item) => item.url), [
    "http://client-api.local/v1/manifest/current",
    "http://client-api.local/v1/research/ticker/GSL",
    "http://client-api.local/v1/research/sector/Financial%20Services",
    "http://client-api.local/v1/research/regime/current",
    "http://client-api.local/v1/research/compare/symbols?a=GSL&b=DAC",
    "http://client-api.local/v1/research/compare/sectors?a=Technology&b=Industrials",
  ]);

  assert.equal(typeof (client as unknown as { request?: unknown }).request, "undefined");
  assert.equal(captures.some((item) => item.url.includes("include_run_ids")), false);
});

test("PipelineOverlayClient attaches auth and ETag headers only when configured", async () => {
  const captures: CapturedRequest[] = [];
  const client = new PipelineOverlayClient({
    baseUrl: "http://client-api.local",
    secret: "secret-value",
    fetchImpl: fakeFetch([jsonResponse({ data: {} }, 200, { etag: "m1" })], captures),
  });

  const result = await client.fetchManifest({ etag: "m0" });
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.etag : undefined, "m1");
  assert.equal((captures[0].init?.headers as Record<string, string>)["X-Grahamy-Secret"], "secret-value");
  assert.equal((captures[0].init?.headers as Record<string, string>)["If-None-Match"], "m0");

  const noSecretCaptures: CapturedRequest[] = [];
  const noSecretClient = new PipelineOverlayClient({
    baseUrl: "http://client-api.local",
    fetchImpl: fakeFetch([jsonResponse({ data: {} })], noSecretCaptures),
  });
  await noSecretClient.fetchManifest();
  assert.equal("X-Grahamy-Secret" in (noSecretCaptures[0].init?.headers as Record<string, string>), false);
});

test("PipelineOverlayClient returns not_modified without raw body on 304", async () => {
  const client = new PipelineOverlayClient({
    baseUrl: "http://client-api.local",
    fetchImpl: fakeFetch([new Response(null, { status: 304 })]),
  });

  const result = await client.fetchTickerResearch("GSL", { etag: "m0" });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.status, "not_modified");
  assert.equal("rawEnvelope" in result, false);
});

test("PipelineOverlayClient maps unavailable status codes safely", async () => {
  const statusCases = [
    { status: 404, reason: "not_found", warning: "Pipeline evidence was not found for the requested input." },
    { status: 429, reason: "rate_limited", warning: "Pipeline evidence is temporarily rate-limited." },
    { status: 500, reason: "upstream_error", warning: "Pipeline evidence is temporarily unavailable." },
  ] as const;

  for (const item of statusCases) {
    const client = new PipelineOverlayClient({
      baseUrl: "http://client-api.local",
      fetchImpl: fakeFetch([jsonResponse({ error: "raw internal error" }, item.status)]),
    });
    const result = await client.fetchTickerResearch("GSL");
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.status, "unavailable");
    if (!result.ok && result.status === "unavailable") {
      assert.equal(result.reason, item.reason);
      assert.equal(result.warning, item.warning);
    }
  }
});

test("PipelineOverlayClient retries network failure and 503 once only", async () => {
  const networkCaptures: CapturedRequest[] = [];
  const networkClient = new PipelineOverlayClient({
    baseUrl: "http://client-api.local",
    fetchImpl: fakeFetch([
      new Error("temporary network failure"),
      jsonResponse({ data: { ok: true } }),
    ], networkCaptures),
  });
  const networkResult = await networkClient.fetchManifest();
  assert.equal(networkResult.ok, true);
  assert.equal(networkCaptures.length, 2);

  const unavailableCaptures: CapturedRequest[] = [];
  const unavailableClient = new PipelineOverlayClient({
    baseUrl: "http://client-api.local",
    fetchImpl: fakeFetch([
      jsonResponse({ error: "service unavailable" }, 503),
      jsonResponse({ error: "still unavailable" }, 503),
    ], unavailableCaptures),
  });
  const unavailableResult = await unavailableClient.fetchManifest();
  assert.equal(unavailableResult.ok, false);
  if (!unavailableResult.ok && unavailableResult.status === "unavailable") {
    assert.equal(unavailableResult.reason, "upstream_error");
  }
  assert.equal(unavailableCaptures.length, 2);

  const notFoundCaptures: CapturedRequest[] = [];
  const notFoundClient = new PipelineOverlayClient({
    baseUrl: "http://client-api.local",
    fetchImpl: fakeFetch([jsonResponse({ error: "not found" }, 404)], notFoundCaptures),
  });
  await notFoundClient.fetchTickerResearch("GSL");
  assert.equal(notFoundCaptures.length, 1);
});

test("PipelineOverlayClient maps timeout and missing config to unavailable", async () => {
  const timeoutClient = new PipelineOverlayClient({
    baseUrl: "http://client-api.local",
    timeoutMs: 5,
    fetchImpl: hangingFetch(),
  });
  const timeout = await timeoutClient.fetchManifest();
  assert.equal(timeout.ok, false);
  if (!timeout.ok && timeout.status === "unavailable") {
    assert.equal(timeout.reason, "timeout");
  }

  const unconfigured = await new PipelineOverlayClient({ baseUrl: "" }).fetchManifest();
  assert.equal(unconfigured.ok, false);
  if (!unconfigured.ok && unconfigured.status === "unavailable") {
    assert.equal(unconfigured.reason, "not_configured");
  }
});

test("manifest freshness adapter exposes only public freshness", () => {
  const freshness = mapManifestToPublicFreshness({
    data: {
      manifest_id: "abc123",
      as_of_date: "2026-05-01",
      created_at: "2026-05-01T14:35:00Z",
      pipeline_complete: true,
      mv_stale: false,
      discovery_run_id: "must-not-leak",
      complete_stages: ["sentinel"],
      running_stages: ["discovery"],
      notes: "{\"complete_stages\":[]}",
      mv_refresh_log_max_ts: "must-not-leak",
      integrity_pct_extreme_alpha: 0.01,
    },
  });

  assert.deepEqual(freshness, {
    dataThrough: "2026-05-01",
    state: "fresh",
  });
  const json = JSON.stringify(freshness);
  for (const forbidden of [
    "run_id",
    "complete_stages",
    "running_stages",
    "notes",
    "mv_refresh_log_max_ts",
    "integrity_pct_extreme_alpha",
  ]) {
    assert.equal(json.includes(forbidden), false);
  }
});

test("manifest freshness adapter maps stale and unknown states safely", () => {
  assert.deepEqual(mapManifestToPublicFreshness({
    data: { as_of_date: "2026-05-01", pipeline_complete: true, mv_stale: true },
  }), {
    dataThrough: "2026-05-01",
    state: "stale",
    warning: "Pipeline data may not be fully refreshed.",
  });

  assert.deepEqual(mapManifestToPublicFreshness({ data: {} }), {
    state: "unknown",
    warning: "Pipeline freshness date is unavailable.",
  });
});

test("public mapper strips forbidden fields recursively", () => {
  const raw = {
    viewSchemaVersion: 1,
    state: "complete",
    safe: "visible",
    nested: {
      symbol: "GSL",
      edge_id: "must-not-leak",
      hypothesis_id: "must-not-leak",
      sections: { narrative: "must-not-leak" },
      claims: [{ text: "must-not-leak" }],
      anchor: { table: "md_hypotheses" },
      derivation: "must-not-leak",
      pipeline_evidence: { total_edges: 5 },
      raw_rows: [{ x: 1 }],
      formulaText: "this contains stop-loss language",
    },
    warnings: [],
  };

  const sanitized = stripForbiddenPipelineOverlayFields(raw);
  assert.deepEqual(sanitized, {
    viewSchemaVersion: 1,
    state: "complete",
    safe: "visible",
    nested: {
      symbol: "GSL",
    },
    warnings: [],
  });
});

test("public mapper result cannot pass raw sections, anchors, or table names", () => {
  const result = createPublicOverlayResult({
    viewSchemaVersion: 1,
    state: "partial",
    freshness: { dataThrough: "2026-05-01", state: "fresh" },
    warnings: ["safe warning"],
    safeSummary: "public text",
    sections: { raw: true },
    anchor: { table: "md_event_returns" },
    claims: [{ text: "raw claim" }],
  } as {
    viewSchemaVersion: number;
    state: "partial";
    freshness: { dataThrough: string; state: "fresh" };
    warnings: string[];
    safeSummary: string;
    sections: { raw: boolean };
    anchor: { table: string };
    claims: Array<{ text: string }>;
  });

  assert.equal(result.state, "partial");
  assert.deepEqual(result.view, {
    viewSchemaVersion: 1,
    state: "partial",
    freshness: { dataThrough: "2026-05-01", state: "fresh" },
    warnings: ["safe warning"],
    safeSummary: "public text",
  });
});

test("overlay registry keeps non-validated overlays as placeholders", () => {
  assert.deepEqual(
    PIPELINE_OVERLAY_REGISTRY.map((entry) => entry.overlayName),
    [
      "validatedEdgeEvidence",
      "sentinelTracking",
      "coronerDecay",
      "dailyDecision",
      "acceptedDiscovery",
      "researchCard",
    ],
  );
  for (const entry of PIPELINE_OVERLAY_REGISTRY) {
    assert.equal(entry.freshnessPolicy, "manifest_public_freshness");
    assert.equal(entry.forbiddenFieldPolicy, "pipeline_overlay_public_safe");
    assert.equal("run" in entry, false);
    if (entry.overlayName === "validatedEdgeEvidence") {
      assert.equal(entry.mapperStatus, "implemented");
    } else {
      assert.equal(entry.mapperStatus, "placeholder");
    }
  }
  assert.equal(pipelineOverlayRegistryEntry("validatedEdgeEvidence")?.mapperStatus, "implemented");
});

test("validated edge evidence mapper whitelists public fields only", () => {
  const mapped = mapValidatedEdgeEvidenceView({
    anchor: { type: "stock", symbol: "GSL", label: "GSL" },
    freshness: { dataThrough: "2026-05-01", state: "fresh" },
    rawEnvelope: {
      data: {
        symbol: "GSL",
        evidence_state: "edge_evidence_present",
        base_rate: {
          value: 0.61,
          median_return_pct: 3.2,
          sample_adequacy: "ADEQUATE",
        },
        path_risk: {
          band: "moderate",
          prob_drawdown_gt_10_pct: 42,
        },
        pipeline_evidence: {
          total_edges: 4,
          events_total: 48,
          mean_hit_rate_by_horizon: { h60: 0.62 },
          mean_alpha_by_horizon: { h60: 0.018 },
          sentinel_active_patterns: 0,
          sentinel_lifecycle_states: {},
          coroner_recent_failures_90d: 0,
          edge_id: "edge-1",
          hypothesis_id: "hyp-1",
          table: "md_hypotheses",
          raw_rows: [{ id: 1 }],
        },
        sections: { raw: true },
        anchors: [{ table: "md_event_returns" }],
        derivation: "internal",
        manifest: { run_id: "run-1" },
      },
    },
  });

  assert.equal(mapped.view.state, "complete");
  assert.equal(mapped.view.anchor.symbol, "GSL");
  assert.equal(mapped.view.evidenceState, "edge_evidence_present");
  assert.equal(mapped.view.edgeCountBucket, "present");
  assert.equal(mapped.view.eventSampleBucket, "adequate");
  assert.equal(mapped.view.horizonEvidence?.[0].horizon, "60-day");
  assert.equal(mapped.view.horizonEvidence?.[0].hitRatePct, 62);
  assert.equal(mapped.view.horizonEvidence?.[0].alphaBucket, "positive");
  assert.equal(mapped.view.baseRateSummary?.hitRatePct, 61);
  assert.equal(mapped.view.baseRateSummary?.medianReturnPct, 3.2);
  assert.equal(mapped.view.pipelineRiskBand, "moderate");
  assert.equal(mapped.view.liveConfirmationBucket, "not_confirmed");
  assert.equal(mapped.view.decayRiskBucket, "no_recent_decay_warning");

  const json = JSON.stringify(mapped.view);
  for (const forbidden of [
    "edge_id",
    "hypothesis_id",
    "raw_rows",
    "sections",
    "anchors",
    "derivation",
    "manifest",
    "md_hypotheses",
    "md_event_returns",
    "prob_drawdown_gt_10_pct",
    "sentinel_lifecycle_states",
    "coroner_recent_failures_90d",
  ]) {
    assert.equal(json.includes(forbidden), false, forbidden);
  }
});

test("validated edge evidence mapper maps aggregate Sentinel buckets without changing evidenceState", () => {
  const ticker = mapValidatedEdgeEvidenceView({
    anchor: { type: "stock", symbol: "GSL", label: "GSL" },
    freshness: { dataThrough: "2026-05-01", state: "fresh" },
    rawEnvelope: {
      data: {
        evidence_state: "edge_evidence_present",
        pipeline_evidence: {
          total_edges: 12,
          events_total: 120,
          sentinel_active_patterns: 0,
          sentinel_lifecycle_states: {},
        },
      },
    },
  });
  assert.equal(ticker.view.evidenceState, "edge_evidence_present");
  assert.equal(ticker.view.liveConfirmationBucket, "not_confirmed");

  const sector = mapValidatedEdgeEvidenceView({
    anchor: { type: "sector", sector: "Energy", label: "Energy" },
    freshness: { dataThrough: "2026-05-01", state: "fresh" },
    rawEnvelope: {
      data: {
        evidence_state: "edge_evidence_strong",
        pipeline_evidence: {
          active_edges: {
            total: 1751,
            by_horizon: { h60: 546 },
            mean_hit_rate_by_horizon: { h60: 0.532 },
            mean_alpha_by_horizon: { h60: 0.0315 },
          },
          events_total: 140979,
          sentinel: {
            active_patterns: 5,
            lifecycle_states: {
              TRACKING: 5,
              COMPLETED_LOSS: 1,
              SUSPENDED_PARENT_INACTIVE: 5,
            },
          },
        },
      },
    },
  });
  assert.equal(sector.view.evidenceState, "edge_evidence_strong");
  assert.equal(sector.view.edgeCountBucket, "strong");
  assert.equal(sector.view.liveConfirmationBucket, "mixed");
  assert.equal(sector.view.horizonEvidence?.[0].horizon, "60-day");

  const regime = mapValidatedEdgeEvidenceView({
    anchor: { type: "regime", regime: "current", label: "current regime" },
    freshness: { dataThrough: "2026-05-01", state: "fresh" },
    rawEnvelope: {
      data: {
        evidence_state: "edge_evidence_present",
        pipeline_evidence: {
          active_edges: { total: 4 },
          sentinel: {
            active_patterns: 0,
            lifecycle_states: {
              COMPLETED_LOSS: 3,
            },
          },
        },
      },
    },
  });
  assert.equal(regime.view.evidenceState, "edge_evidence_present");
  assert.equal(regime.view.liveConfirmationBucket, "deteriorating");
});

test("validated edge evidence mapper maps aggregate Coroner bucket without changing evidenceState", () => {
  const watch = mapValidatedEdgeEvidenceView({
    anchor: { type: "stock", symbol: "GSL", label: "GSL" },
    freshness: { dataThrough: "2026-05-01", state: "fresh" },
    rawEnvelope: {
      data: {
        evidence_state: "edge_evidence_present",
        pipeline_evidence: {
          total_edges: 12,
          coroner_recent_failures_90d: 2,
          coroner_postmortems: [{ parent_refined_out: true }],
        },
      },
    },
  });
  assert.equal(watch.view.evidenceState, "edge_evidence_present");
  assert.equal(watch.view.decayRiskBucket, "watch");
  assert.match(watch.view.warnings.join(" "), /decay risk is on watch/i);

  const elevated = mapValidatedEdgeEvidenceView({
    anchor: { type: "stock", symbol: "GSL", label: "GSL" },
    freshness: { dataThrough: "2026-05-01", state: "fresh" },
    rawEnvelope: {
      data: {
        evidence_state: "edge_evidence_strong",
        pipeline_evidence: {
          total_edges: 12,
          coroner_recent_failures_90d: 3,
        },
      },
    },
  });
  assert.equal(elevated.view.evidenceState, "edge_evidence_strong");
  assert.equal(elevated.view.decayRiskBucket, "decay_elevated");
  assert.match(elevated.view.warnings.join(" "), /decay risk is elevated/i);

  const json = JSON.stringify(watch.view);
  for (const forbidden of [
    "coroner_recent_failures_90d",
    "coroner_postmortems",
    "parent_refined_out",
    "parent refined out",
    "COMPLETED_LOSS",
    "SUSPENDED_PARENT_INACTIVE",
    "TRACKING",
  ]) {
    assert.equal(json.includes(forbidden), false, forbidden);
  }
});

test("validated edge evidence overlay calls manifest and ticker Client API endpoints", async () => {
  const captures: CapturedRequest[] = [];
  const client = new PipelineOverlayClient({
    baseUrl: "http://client-api.local",
    fetchImpl: fakeFetch([
      jsonResponse({ data: { as_of_date: "2026-05-01", pipeline_complete: true } }),
      jsonResponse({
        data: {
          evidence_state: "edge_evidence_strong",
          pipeline_evidence: {
            total_edges: 12,
            events_total: 160,
          },
        },
      }),
    ], captures),
  });

  const result = await executeValidatedEdgeEvidenceOverlay({
    message: "Is GSL evidence-backed?",
    classification: {
      intent: "stock",
      symbols: ["GSL"],
      sectors: [],
      regimeRequested: false,
      isFollowUp: false,
      focus: "validated_evidence",
      requiresTools: ["get_stock_snapshot_context", "get_market_context"],
      confidence: "high",
      warnings: [],
    },
  }, client);

  assert.deepEqual(captures.map((item) => item.url), [
    "http://client-api.local/v1/manifest/current",
    "http://client-api.local/v1/research/ticker/GSL",
  ]);
  assert.equal(result.views.validatedEdgeEvidenceView?.state, "complete");
  assert.equal(result.views.validatedEdgeEvidenceView?.evidenceState, "edge_evidence_strong");
  assert.equal(result.views.validatedEdgeEvidenceView?.freshness.dataThrough, "2026-05-01");
});

test("validated edge evidence overlay maps upstream failures to unavailable", async () => {
  const client = new PipelineOverlayClient({
    baseUrl: "http://client-api.local",
    fetchImpl: fakeFetch([
      jsonResponse({ data: { as_of_date: "2026-05-01", pipeline_complete: true } }),
      jsonResponse({ error: "rate limited" }, 429),
    ]),
  });

  const result = await executeValidatedEdgeEvidenceOverlay({
    message: "Does Energy have validated edge evidence?",
    classification: {
      intent: "sector",
      symbols: [],
      sectors: ["Energy"],
      regimeRequested: false,
      isFollowUp: false,
      focus: "validated_evidence",
      requiresTools: ["get_sector_snapshot_context", "get_market_context"],
      confidence: "high",
      warnings: [],
    },
  }, client);

  assert.equal(result.views.validatedEdgeEvidenceView?.state, "unavailable");
  assert.equal(result.views.validatedEdgeEvidenceView?.evidenceState, "unavailable");
  assert.match(result.views.validatedEdgeEvidenceView?.warnings.join(" ") ?? "", /rate-limited/i);
});

test("validated edge evidence overlay exposes stale manifest caveat publicly", async () => {
  const client = new PipelineOverlayClient({
    baseUrl: "http://client-api.local",
    fetchImpl: fakeFetch([
      jsonResponse({
        data: {
          as_of_date: "2026-05-01",
          pipeline_complete: true,
          mv_stale: true,
        },
      }),
      jsonResponse({
        data: {
          evidence_state: "insufficient_data",
          base_rate: { hit_rate_pct: 54.2 },
        },
      }),
    ]),
  });

  const result = await executeValidatedEdgeEvidenceOverlay({
    message: "Is the current regime evidence-backed?",
    classification: {
      intent: "regime",
      symbols: [],
      sectors: [],
      regimeRequested: true,
      isFollowUp: false,
      focus: "validated_evidence",
      requiresTools: ["get_market_context"],
      confidence: "high",
      warnings: [],
    },
  }, client);

  const view = result.views.validatedEdgeEvidenceView;
  assert.equal(view?.state, "complete");
  assert.equal(view?.anchor.type, "regime");
  assert.equal(view?.freshness.state, "stale");
  assert.match(view?.warnings.join(" ") ?? "", /fully refreshed/i);
});

test("validated edge evidence overlay returns unavailable without an anchor", async () => {
  const result = await executeValidatedEdgeEvidenceOverlay({
    message: "Is this setup supported by the pipeline?",
    classification: {
      intent: "unknown",
      symbols: [],
      sectors: [],
      regimeRequested: false,
      isFollowUp: true,
      focus: "validated_evidence",
      requiresTools: [],
      confidence: "low",
      warnings: [],
    },
  }, new PipelineOverlayClient({ baseUrl: "" }));

  assert.equal(result.views.validatedEdgeEvidenceView?.state, "unavailable");
  assert.match(result.warnings.join(" "), /specific stock, sector, or regime/i);
});

test("pipeline overlay production files contain no direct database access hooks", async () => {
  const dir = path.join(__dirname, "pipelineOverlays");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".ts"));
  const searchableFiles = files.filter((file) => file !== "forbiddenFields.ts");
  const content = await Promise.all(
    searchableFiles.map(async (file) => ({
      file,
      text: await readFile(path.join(dir, file), "utf8"),
    })),
  );

  for (const { file, text } of content) {
    assert.equal(text.includes("sqlite3"), false, `${file} imports direct SQLite access`);
    assert.equal(text.includes("better-sqlite3"), false, `${file} imports direct SQLite access`);
    assert.equal(text.includes("grahamy_discovery"), false, `${file} references direct Pipeline storage`);
    assert.equal(text.includes("grahamy_ops"), false, `${file} references direct ops storage`);
    assert.equal(/\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i.test(text), false, `${file} contains raw SQL`);
  }

  assert.ok(
    PIPELINE_OVERLAY_FORBIDDEN_TERMS.includes("grahamy_discovery.db"),
    "policy file still blocks the direct Pipeline storage name at runtime",
  );
});
