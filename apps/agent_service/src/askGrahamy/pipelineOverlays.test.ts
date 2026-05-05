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

test("overlay registry is skeleton-only and contains no business implementation", () => {
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
    assert.equal(entry.mapperStatus, "placeholder");
    assert.equal(entry.freshnessPolicy, "manifest_public_freshness");
    assert.equal(entry.forbiddenFieldPolicy, "pipeline_overlay_public_safe");
    assert.equal("run" in entry, false);
  }
  assert.equal(pipelineOverlayRegistryEntry("validatedEdgeEvidence")?.mapperStatus, "placeholder");
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
