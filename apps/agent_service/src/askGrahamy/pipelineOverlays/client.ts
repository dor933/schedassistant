import { unavailableResult } from "./errors";
import type {
  PipelineClientApiSource,
  PipelineClientOptions,
  PipelineClientRequestOptions,
  PipelineClientResult,
  PipelineRegime,
} from "./types";

const DEFAULT_TIMEOUT_MS = 5_000;
const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,5}$/;
const ALLOWED_REGIMES = new Set<PipelineRegime>([
  "current",
  "RISK_ON",
  "NEUTRAL",
  "RISK_OFF",
]);

export class PipelineOverlayClient {
  private readonly baseUrl: string;
  private readonly secret?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PipelineClientOptions = {}) {
    this.baseUrl = stripTrailingSlash(
      options.baseUrl ?? process.env.GRAHAMY_CLIENT_API_BASE_URL ?? "",
    );
    this.secret = options.secret ?? process.env.GRAHAMY_CLIENT_API_SECRET;
    this.timeoutMs = Number(
      options.timeoutMs ??
        process.env.GRAHAMY_CLIENT_API_TIMEOUT_MS ??
        DEFAULT_TIMEOUT_MS,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  fetchManifest(options: PipelineClientRequestOptions = {}): Promise<PipelineClientResult> {
    return this.get("manifest", "/v1/manifest/current", options);
  }

  fetchTickerResearch(
    symbol: string,
    options: PipelineClientRequestOptions = {},
  ): Promise<PipelineClientResult> {
    const normalized = symbol.trim().toUpperCase();
    if (!SYMBOL_RE.test(normalized)) {
      return Promise.resolve(unavailableResult({
        source: "tickerResearch",
        reason: "bad_request",
      }));
    }
    return this.get(
      "tickerResearch",
      `/v1/research/ticker/${encodeURIComponent(normalized)}`,
      options,
    );
  }

  fetchSectorResearch(
    sector: string,
    options: PipelineClientRequestOptions = {},
  ): Promise<PipelineClientResult> {
    const normalized = sector.trim();
    if (!normalized) {
      return Promise.resolve(unavailableResult({
        source: "sectorResearch",
        reason: "bad_request",
      }));
    }
    return this.get(
      "sectorResearch",
      `/v1/research/sector/${encodeURIComponent(normalized)}`,
      options,
    );
  }

  fetchRegimeResearch(
    regime: PipelineRegime,
    options: PipelineClientRequestOptions = {},
  ): Promise<PipelineClientResult> {
    if (!ALLOWED_REGIMES.has(regime)) {
      return Promise.resolve(unavailableResult({
        source: "regimeResearch",
        reason: "bad_request",
      }));
    }
    return this.get(
      "regimeResearch",
      `/v1/research/regime/${encodeURIComponent(regime)}`,
      options,
    );
  }

  fetchSymbolComparison(
    a: string,
    b: string,
    options: PipelineClientRequestOptions = {},
  ): Promise<PipelineClientResult> {
    const left = a.trim().toUpperCase();
    const right = b.trim().toUpperCase();
    if (!SYMBOL_RE.test(left) || !SYMBOL_RE.test(right) || left === right) {
      return Promise.resolve(unavailableResult({
        source: "symbolComparison",
        reason: "bad_request",
      }));
    }
    return this.get(
      "symbolComparison",
      `/v1/research/compare/symbols?a=${encodeURIComponent(left)}&b=${encodeURIComponent(right)}`,
      options,
    );
  }

  fetchSectorComparison(
    a: string,
    b: string,
    options: PipelineClientRequestOptions = {},
  ): Promise<PipelineClientResult> {
    const left = a.trim();
    const right = b.trim();
    if (!left || !right || left.toLowerCase() === right.toLowerCase()) {
      return Promise.resolve(unavailableResult({
        source: "sectorComparison",
        reason: "bad_request",
      }));
    }
    return this.get(
      "sectorComparison",
      `/v1/research/compare/sectors?a=${encodeURIComponent(left)}&b=${encodeURIComponent(right)}`,
      options,
    );
  }

  private async get(
    source: PipelineClientApiSource,
    path: string,
    options: PipelineClientRequestOptions,
  ): Promise<PipelineClientResult> {
    if (!this.baseUrl) {
      return unavailableResult({ source, reason: "not_configured" });
    }

    const first = await this.requestOnce(source, path, options);
    if (shouldRetry(first)) {
      return this.requestOnce(source, path, options);
    }
    return first;
  }

  private async requestOnce(
    source: PipelineClientApiSource,
    path: string,
    options: PipelineClientRequestOptions,
  ): Promise<PipelineClientResult> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: this.headers(options),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;
      const etag = response.headers.get("etag") ?? undefined;

      if (response.status === 304) {
        return {
          ok: false,
          source,
          status: "not_modified",
          statusCode: 304,
          latencyMs,
          etag,
        };
      }

      if (!response.ok) {
        return unavailableResult({
          source,
          reason: reasonForStatus(response.status),
          statusCode: response.status,
          latencyMs,
          retryAfterSeconds: retryAfterSeconds(response.headers.get("retry-after")),
        });
      }

      return {
        ok: true,
        source,
        statusCode: response.status,
        rawEnvelope: await response.json(),
        latencyMs,
        etag,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      return unavailableResult({
        source,
        reason:
          err instanceof Error && err.name === "AbortError"
            ? "timeout"
            : "network_error",
        latencyMs,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(options: PipelineClientRequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.secret) headers["X-Grahamy-Secret"] = this.secret;
    if (options.etag) headers["If-None-Match"] = options.etag;
    return headers;
  }
}

function shouldRetry(result: PipelineClientResult): boolean {
  return !result.ok && result.status === "unavailable" &&
    (result.reason === "network_error" || result.statusCode === 503);
}

function reasonForStatus(status: number) {
  if (status === 400) return "bad_request" as const;
  if (status === 404) return "not_found" as const;
  if (status === 429) return "rate_limited" as const;
  return "upstream_error" as const;
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

