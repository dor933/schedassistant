import type { PublicFreshnessView } from "../types";

type ManifestLike = Record<string, unknown>;

export function mapManifestToPublicFreshness(envelope: unknown): PublicFreshnessView {
  const data = extractDataObject(envelope);
  if (!data) {
    return {
      state: "unknown",
      warning: "Pipeline freshness metadata is unavailable.",
    };
  }

  const dataThrough = stringValue(data.as_of_date);
  const pipelineComplete = booleanValue(data.pipeline_complete);
  const mvStale = booleanValue(data.mv_stale);
  const pipelineAlertActive = booleanValue(data.pipeline_alert_active);

  if (!dataThrough) {
    return {
      state: "unknown",
      warning: "Pipeline freshness date is unavailable.",
    };
  }

  if (mvStale === true || pipelineAlertActive === true) {
    return {
      dataThrough,
      state: "stale",
      warning: "Pipeline data may not be fully refreshed.",
    };
  }

  if (pipelineComplete === false) {
    return {
      dataThrough,
      state: "stale",
      warning: "Pipeline data may be incomplete.",
    };
  }

  return {
    dataThrough,
    state: pipelineComplete === undefined ? "unknown" : "fresh",
    ...(pipelineComplete === undefined
      ? { warning: "Pipeline freshness state is unknown." }
      : {}),
  };
}

function extractDataObject(value: unknown): ManifestLike | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.data)) return value.data;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

