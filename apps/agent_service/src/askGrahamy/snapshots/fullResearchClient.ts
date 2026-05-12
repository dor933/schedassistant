import { isRecord } from "./snapshotClient";

export type FullTickerResearchResult =
  | {
      ok: true;
      researchObject: Record<string, unknown>;
      latencyMs: number;
    }
  | {
      ok: false;
      warning?: string;
      latencyMs?: number;
    };

const DEFAULT_TIMEOUT_MS = 5_000;

export async function fetchFullTickerResearchObject(
  symbol: string,
  asOfDate?: string,
): Promise<FullTickerResearchResult> {
  if (process.env.ASK_GRAHAMY_FULL_RESEARCH_ENABLED === "false") {
    return { ok: false };
  }

  const baseUrl = stripTrailingSlash(
    process.env.GRAHAMY_FULL_RESEARCH_BASE_URL ??
      process.env.GRAHAMY_AGENTS_BASE_URL ??
      "",
  );
  if (!baseUrl) return { ok: false };

  const timeoutMs = Number(
    process.env.GRAHAMY_FULL_RESEARCH_TIMEOUT_MS ??
      process.env.GRAHAMY_AGENTS_TIMEOUT_MS ??
      DEFAULT_TIMEOUT_MS,
  );
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const query = asOfDate ? `?as_of=${encodeURIComponent(asOfDate)}` : "";

  try {
    const response = await fetch(
      `${baseUrl}/api/client/v1/research/ticker/${encodeURIComponent(symbol)}${query}`,
      { method: "GET", signal: controller.signal },
    );
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      return {
        ok: false,
        warning: `Full Research Object endpoint returned ${response.status} for ${symbol}.`,
        latencyMs,
      };
    }
    const body = await response.json();
    const data = isRecord(body) && isRecord(body.data) ? body.data : body;
    if (!isRecord(data)) {
      return {
        ok: false,
        warning: `Full Research Object endpoint returned an invalid payload for ${symbol}.`,
        latencyMs,
      };
    }
    return { ok: true, researchObject: data, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      ok: false,
      warning:
        err instanceof Error && err.name === "AbortError"
          ? `Full Research Object endpoint timed out for ${symbol}.`
          : `Full Research Object endpoint failed for ${symbol}.`,
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
