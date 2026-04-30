import type { FreshnessMetadata, SnapshotBundle, SnapshotName } from "./types";

const SNAPSHOT_NAMES: SnapshotName[] = [
  "daily_brief",
  "metadata",
  "clusters",
  "track_record",
  "transparency",
];

export type SnapshotClientOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class GrahamySnapshotClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SnapshotClientOptions = {}) {
    this.baseUrl = stripTrailingSlash(
      options.baseUrl ?? process.env.GRAHAMY_AGENTS_BASE_URL ?? "",
    );
    this.timeoutMs = Number(options.timeoutMs ?? process.env.GRAHAMY_AGENTS_TIMEOUT_MS ?? 5000);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchPublishedSnapshots(): Promise<SnapshotBundle> {
    if (!this.baseUrl) {
      return {
        errors: Object.fromEntries(SNAPSHOT_NAMES.map((name) => [name, "GRAHAMY_AGENTS_BASE_URL is not configured."])),
        freshness: { stale: true, staleReason: "Snapshot service is not configured." },
      };
    }

    const entries = await Promise.all(SNAPSHOT_NAMES.map((name) => this.fetchSnapshot(name)));
    const bundle: SnapshotBundle = { errors: {}, latencyMs: {} };
    for (const entry of entries) {
      if (entry.ok) {
        bundle[entry.name] = entry.data;
      } else {
        bundle.errors![entry.name] = entry.error;
      }
      bundle.latencyMs![entry.name] = entry.latencyMs;
    }
    bundle.freshness = extractFreshness(bundle.metadata, bundle.transparency);
    return bundle;
  }

  private async fetchSnapshot(name: SnapshotName): Promise<
    | { ok: true; name: SnapshotName; data: unknown; latencyMs: number }
    | { ok: false; name: SnapshotName; error: string; latencyMs: number }
  > {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/client/snapshot/${name}`, {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          ok: false,
          name,
          error: `Snapshot ${name} returned ${response.status}.`,
          latencyMs: Date.now() - start,
        };
      }
      return {
        ok: true,
        name,
        data: await response.json(),
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        ok: false,
        name,
        error: err instanceof Error && err.name === "AbortError"
          ? `Snapshot ${name} timed out.`
          : `Snapshot ${name} failed.`,
        latencyMs: Date.now() - start,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function extractFreshness(metadata: unknown, transparency: unknown): FreshnessMetadata {
  const meta = isRecord(metadata) ? metadata : {};
  const transparencyObj = isRecord(transparency) ? transparency : {};
  const generatedAt = stringValue(meta.generated_at);
  const dataThrough = stringValue(meta.data_through);
  const pipelineStatus = stringValue(meta.pipeline_status);
  const dataFreshness =
    stringValue(transparencyObj.data_freshness) ||
    extractPipelineHealthFreshness(transparencyObj.pipeline_health);

  const freshness: FreshnessMetadata = {
    generatedAt,
    dataThrough,
    pipelineStatus,
    dataFreshness,
  };

  if (!generatedAt && !dataThrough && !dataFreshness) {
    freshness.stale = true;
    freshness.staleReason = "Snapshot freshness metadata is missing.";
  } else if (pipelineStatus && !["OPERATIONAL", "OK"].includes(pipelineStatus.toUpperCase())) {
    freshness.stale = true;
    freshness.staleReason = `Pipeline status is ${pipelineStatus}.`;
  }

  return freshness;
}

function extractPipelineHealthFreshness(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (String(item.name ?? "").toLowerCase() === "last health check") {
      return stringValue(item.value);
    }
  }
  return undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

