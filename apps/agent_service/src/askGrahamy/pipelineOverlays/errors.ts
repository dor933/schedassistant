import type {
  PipelineClientApiSource,
  PipelineClientUnavailable,
  PipelineClientUnavailableReason,
} from "./types";

export function unavailableResult(params: {
  source: PipelineClientApiSource;
  reason: PipelineClientUnavailableReason;
  statusCode?: number;
  latencyMs?: number;
  retryAfterSeconds?: number;
}): PipelineClientUnavailable {
  return {
    ok: false,
    source: params.source,
    status: "unavailable",
    reason: params.reason,
    statusCode: params.statusCode,
    latencyMs: params.latencyMs,
    retryAfterSeconds: params.retryAfterSeconds,
    warning: publicWarningForReason(params.reason),
  };
}

export function publicWarningForReason(reason: PipelineClientUnavailableReason): string {
  switch (reason) {
    case "not_configured":
      return "Pipeline evidence is temporarily unavailable.";
    case "bad_request":
      return "Pipeline evidence is unavailable for the requested input.";
    case "not_found":
      return "Pipeline evidence was not found for the requested input.";
    case "rate_limited":
      return "Pipeline evidence is temporarily rate-limited.";
    case "timeout":
      return "Pipeline evidence timed out.";
    case "network_error":
    case "upstream_error":
    default:
      return "Pipeline evidence is temporarily unavailable.";
  }
}

